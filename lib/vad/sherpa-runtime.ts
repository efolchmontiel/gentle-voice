/**
 * sherpa-onnx runtime for Silero VAD. Replaces the onnxruntime-node optional
 * dependency (548 MB with CUDA and every platform) with one pinned platform
 * package (9–14 MB download). Gentle Shell's dictation installs the same pins,
 * so its runtime is reused when present. Nothing is downloaded without consent.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { resolveGentleVoiceStorage } from "../runtime/storage.ts";

export const SHERPA_VERSION = "1.13.8";
/** Gentle Shell names its runtime after both native pins. */
const GENTLE_SHELL_NODE_CPAL_VERSION = "1.0.0";

export type SherpaTarget = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win32-x64";

export interface SherpaPackage {
	readonly name: string;
	/** Packed tarball size in bytes and the registry `dist.integrity`. */
	readonly size: number;
	readonly integrity: string;
	/** Registry `dist.unpackedSize` and `dist.fileCount`. */
	readonly unpackedSize: number;
	readonly fileCount: number;
	readonly requiredFile: string;
}

/** Same pins as Gentle Shell `lib/voice-artifacts.ts`, read from the npm registry. */
export const SHERPA_NODE: SherpaPackage = {
	name: "sherpa-onnx-node",
	size: 11_954,
	integrity: "sha512-MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag==",
	unpackedSize: 61_221,
	fileCount: 19,
	requiredFile: "vad.js",
};

export const SHERPA_PLATFORM: Readonly<Record<SherpaTarget, SherpaPackage>> = {
	"linux-x64": platform("linux-x64", 11_089_653, "sha512-6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==", 33_381_117, 7),
	"linux-arm64": platform("linux-arm64", 13_910_679, "sha512-Tlg7a70b/Wge3OF8IgTHF9jhSVCsLyKQKhwc4BsJ5A+dL/SrFtGBjzuHp4XeLhiiOT7afCxX5PdSn/D4c8Lnuw==", 40_306_856, 7),
	"darwin-x64": platform("darwin-x64", 11_191_481, "sha512-7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g==", 37_678_686, 7),
	"darwin-arm64": platform("darwin-arm64", 10_047_754, "sha512-FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==", 34_089_738, 7),
	"win32-x64": platform("win32-x64", 8_894_875, "sha512-oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g==", 23_453_246, 8),
};

function platform(target: SherpaTarget, size: number, integrity: string, unpackedSize: number, fileCount: number): SherpaPackage {
	return {
		// The loader in sherpa-onnx-node spells Windows "win".
		name: `sherpa-onnx-${target.replace(/^win32-/, "win-")}`,
		size,
		integrity,
		unpackedSize,
		fileCount,
		requiredFile: "sherpa-onnx.node",
	};
}

export function sherpaTarget(
	os: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): SherpaTarget | undefined {
	const target = `${os}-${arch}`;
	return target in SHERPA_PLATFORM ? target as SherpaTarget : undefined;
}

export function sherpaPackages(target: SherpaTarget): readonly SherpaPackage[] {
	return [SHERPA_NODE, SHERPA_PLATFORM[target]];
}

export function sherpaDownloadBytes(target: SherpaTarget): number {
	return sherpaPackages(target).reduce((sum, pkg) => sum + pkg.size, 0);
}

export function sherpaInstalledBytes(target: SherpaTarget): number {
	return sherpaPackages(target).reduce((sum, pkg) => sum + pkg.unpackedSize, 0);
}

export function privateSherpaRuntimeDir(target: SherpaTarget, env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveGentleVoiceStorage({ env }).dataDir, "runtime", `sherpa-onnx-${SHERPA_VERSION}-${target}`);
}

/** Where Gentle Shell's `/gentle:voice` download puts the same runtime. */
export function gentleShellSherpaRuntimeDir(target: SherpaTarget, env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.GENTLE_PI_CONFIG_HOME?.trim();
	const home = env.HOME?.trim() || homedir();
	const configHome = explicit && isAbsolute(explicit) ? explicit : join(home, ".pi", "gentle-ai");
	return join(
		configHome,
		"voice",
		"runtime",
		`sherpa-onnx-${SHERPA_VERSION}-node-cpal-${GENTLE_SHELL_NODE_CPAL_VERSION}-${target}`,
	);
}

function runtimeComplete(dir: string, target: SherpaTarget): boolean {
	return sherpaPackages(target).every((pkg) => existsSync(join(dir, "node_modules", pkg.name, pkg.requiredFile)));
}

export interface SherpaRuntime {
	readonly dir: string;
	readonly source: "gentle-voice" | "gentle-shell";
}

export function resolveSherpaRuntime(env: NodeJS.ProcessEnv = process.env): SherpaRuntime | undefined {
	const target = sherpaTarget();
	if (!target) return undefined;
	// An env without a home (unit tests) must not find the developer's real install.
	if (!env.HOME?.trim() && !env.GENTLE_VOICE_HOME?.trim() && !env.GENTLE_PI_CONFIG_HOME?.trim()) return undefined;
	const own = privateSherpaRuntimeDir(target, env);
	if (runtimeComplete(own, target)) return { dir: own, source: "gentle-voice" };
	const shell = gentleShellSherpaRuntimeDir(target, env);
	if (runtimeComplete(shell, target)) return { dir: shell, source: "gentle-shell" };
	return undefined;
}

export interface SherpaVadHandle {
	acceptWaveform(samples: Float32Array): void;
	isDetected(): boolean;
	isEmpty(): boolean;
	pop(): void;
	reset(): void;
}

export interface SherpaModule {
	Vad: new (config: object, bufferSizeInSeconds: number) => SherpaVadHandle;
}

/** Loads the native addon from the resolved runtime only. */
export function loadSherpa(runtime: SherpaRuntime): SherpaModule {
	const require = createRequire(join(runtime.dir, "node_modules", "package.json"));
	return require(join(runtime.dir, "node_modules", SHERPA_NODE.name, "vad.js")) as SherpaModule;
}

function tarballUrl(name: string): string {
	return `https://registry.npmjs.org/${name}/-/${name}-${SHERPA_VERSION}.tgz`;
}

async function fetchVerified(pkg: SherpaPackage, signal: AbortSignal): Promise<Buffer> {
	// The registry serves tarballs directly. A redirect would be another origin.
	const response = await fetch(tarballUrl(pkg.name), { signal, redirect: "error" });
	if (!response.ok) throw new Error(`sherpa_http_${response.status}:${pkg.name}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.byteLength !== pkg.size) throw new Error(`sherpa_size_${bytes.byteLength}:${pkg.name}`);
	const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	if (digest !== pkg.integrity) throw new Error(`sherpa_integrity:${pkg.name}`);
	return bytes;
}

function tar(args: readonly string[], signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("tar", [...args], { stdio: ["ignore", "pipe", "pipe"], signal });
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`tar_exit_${code}:${err.slice(0, 200)}`)));
	});
}

/** Only regular files under package/, no traversal, within the registry file count. */
export function checkTarListing(verbose: string, pkg: SherpaPackage): void {
	const lines = verbose.split("\n").filter((line) => line.trim());
	let files = 0;
	for (const line of lines) {
		const kind = line[0];
		const path = line.split(/\s+/).slice(-1)[0] ?? "";
		if (kind === "d") continue;
		if (kind !== "-") throw new Error(`sherpa_archive_entry:${pkg.name}`);
		if (!path.startsWith("package/") || path.split("/").includes("..")) {
			throw new Error(`sherpa_archive_path:${pkg.name}`);
		}
		files += 1;
	}
	if (files === 0 || files > pkg.fileCount) throw new Error(`sherpa_archive_count:${pkg.name}`);
}

/**
 * Download, verify and publish the runtime in one rename. A failure removes
 * only the staging directory; a complete runtime is never overwritten.
 */
export async function installSherpaRuntime(
	target: SherpaTarget,
	env: NodeJS.ProcessEnv = process.env,
	signal: AbortSignal = new AbortController().signal,
): Promise<SherpaRuntime> {
	const dir = privateSherpaRuntimeDir(target, env);
	if (runtimeComplete(dir, target)) return { dir, source: "gentle-voice" };
	const staging = `${dir}.staging-${process.pid}`;
	await rm(staging, { recursive: true, force: true });
	try {
		for (const pkg of sherpaPackages(target)) {
			const bytes = await fetchVerified(pkg, signal);
			const archive = join(staging, `${pkg.name}.tgz`);
			const destination = join(staging, "node_modules", pkg.name);
			await mkdir(destination, { recursive: true });
			await writeFile(archive, bytes, { mode: 0o600 });
			checkTarListing(await tar(["-tvzf", archive], signal), pkg);
			await tar(["-xzf", archive, "-C", destination, "--strip-components=1"], signal);
			await rm(archive, { force: true });
			if (!existsSync(join(destination, pkg.requiredFile))) throw new Error(`sherpa_missing_file:${pkg.name}`);
		}
		await rm(dir, { recursive: true, force: true });
		await rename(staging, dir);
		return { dir, source: "gentle-voice" };
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}
