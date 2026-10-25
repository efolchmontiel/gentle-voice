/**
 * Kokoro install: pinned model and voices, a private venv, one pip package.
 * Network and process I/O are injected. Tests pass fakes.
 * No sudo, no system Python changes, no pip cache.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createNetworkOnboardingIo } from "../vibevoice/network-io.ts";
import { writeTtsEnginePreference } from "../vibevoice/tts-preference.ts";
import { kokoroVenvPython, kokoroWorkerScript, probeKokoroReadiness } from "./home.ts";
import {
	KOKORO_ARTIFACTS,
	KOKORO_DEFAULT_VOICE,
	KOKORO_INSTALLED_BYTES,
	KOKORO_INTEGRITY_KIND,
	KOKORO_LANG,
	KOKORO_PIP_REQUIREMENTS,
	type KokoroArtifact,
} from "./manifest.ts";

/** onnxruntime publishes CPython 3.11 to 3.14 wheels. */
export const KOKORO_PYTHON_CANDIDATES = ["python3.14", "python3.13", "python3.12", "python3.11", "python3"] as const;
export const KOKORO_PYTHON_PROBE = "import sys; print(f'GVPY {sys.version_info[0]}.{sys.version_info[1]}')";

export function kokoroPythonSupported(report: string): boolean {
	const match = /GVPY\s+(\d+)\.(\d+)/.exec(report);
	if (!match) return false;
	return Number(match[1]) === 3 && Number(match[2]) >= 11 && Number(match[2]) <= 14;
}

/** Synchronous check for the onboarding menu. An installed Kokoro does not need a base Python. */
export function kokoroBasePythonAvailable(
	run: (command: string) => string | undefined = (command) => {
		const result = spawnSync(command, ["-c", KOKORO_PYTHON_PROBE], { encoding: "utf8", timeout: 5_000 });
		return result.status === 0 ? result.stdout : undefined;
	},
): boolean {
	return KOKORO_PYTHON_CANDIDATES.some((command) => kokoroPythonSupported(run(command) ?? ""));
}

export interface KokoroInstallIo {
	fetch(url: string, destination: string, signal: AbortSignal): Promise<void>;
	run(command: string, args: readonly string[], signal: AbortSignal): Promise<{ code: number; detail?: string }>;
}

export type KokoroInstallStatus =
	| "installed"
	| "reused"
	| "declined"
	| "consent_unavailable"
	| "cancelled"
	| "corrupt"
	| "failed";

export interface KokoroInstallResult {
	readonly status: KokoroInstallStatus;
	readonly reason: string;
	readonly fetched: readonly string[];
	readonly detail?: string;
}

export function formatKokoroConsent(targetDir: string): string {
	const mb = Math.round(KOKORO_INSTALLED_BYTES / 1_000_000);
	return [
		"Kokoro is a natural Spanish voice that runs on the CPU. No GPU is needed.",
		`Disk: about ${mb} MB (model, voices, and a private Python environment).`,
		`Location: ${targetDir}`,
		"Licenses: Kokoro model Apache-2.0, kokoro-onnx MIT, phonemizer and espeak-ng GPL-3.0.",
		"Nothing is installed until you accept.",
	].join("\n");
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolveHash, reject) => {
		createReadStream(path)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolveHash());
	});
	return hash.digest("hex");
}

export async function kokoroArtifactMatches(path: string, artifact: KokoroArtifact): Promise<boolean> {
	try {
		if ((await stat(path)).size !== artifact.bytes) return false;
		return (await sha256File(path)) === artifact.sha256;
	} catch {
		return false;
	}
}

function assertNoPrivilege(command: string, args: readonly string[]): void {
	if (command === "sudo" || args.includes("sudo")) throw new Error("sudo_refused");
}

async function run(
	io: KokoroInstallIo,
	command: string,
	args: readonly string[],
	signal: AbortSignal,
): Promise<{ code: number; detail?: string }> {
	assertNoPrivilege(command, args);
	const result = await io.run(command, args, signal);
	if (signal.aborted) throw new Error("cancelled");
	return result;
}

async function selectBasePython(io: KokoroInstallIo, signal: AbortSignal): Promise<string> {
	for (const command of KOKORO_PYTHON_CANDIDATES) {
		try {
			const probed = await io.run(command, ["-c", KOKORO_PYTHON_PROBE], signal);
			if (probed.code === 0 && kokoroPythonSupported(probed.detail ?? "")) return command;
		} catch {
			continue;
		}
	}
	throw Object.assign(new Error("python_unsupported"), {
		detail: "Kokoro needs Python 3.11 to 3.14 to create its private environment.",
	});
}

export async function runKokoroInstall(input: {
	readonly targetDir: string;
	readonly voiceHome: string;
	readonly consent: boolean | undefined;
	readonly io?: KokoroInstallIo;
	readonly signal?: AbortSignal;
	readonly onProgress?: (message: string) => void;
	readonly workerScript?: string;
	/** Test seam. Production uses the pinned release. */
	readonly artifacts?: readonly KokoroArtifact[];
}): Promise<KokoroInstallResult> {
	const artifacts = input.artifacts ?? KOKORO_ARTIFACTS;
	const signal = input.signal ?? new AbortController().signal;
	const fetched: string[] = [];
	if (probeKokoroReadiness({ ...process.env, GENTLE_VOICE_KOKORO_HOME: input.targetDir }).ready) {
		writeTtsEnginePreference(input.voiceHome, "kokoro");
		return { status: "reused", reason: "existing_engine", fetched };
	}
	if (input.consent === undefined) return { status: "consent_unavailable", reason: "confirm_required", fetched };
	if (!input.consent) return { status: "declined", reason: "user_declined", fetched };
	const io = input.io ?? createKokoroNetworkIo();
	const progress = (message: string): void => input.onProgress?.(message);
	try {
		for (const artifact of artifacts) {
			if (signal.aborted) throw new Error("cancelled");
			const dest = join(input.targetDir, artifact.relativePath);
			if (await kokoroArtifactMatches(dest, artifact)) continue;
			progress(artifact.id === "model" ? "Downloading the Kokoro model" : "Downloading the Kokoro voices");
			const partial = `${dest}.partial`;
			await mkdir(dirname(dest), { recursive: true });
			try {
				await io.fetch(artifact.origin, partial, signal);
			} catch (error) {
				await rm(partial, { force: true });
				throw error;
			}
			if (!(await kokoroArtifactMatches(partial, artifact))) {
				await rm(partial, { force: true });
				throw Object.assign(new Error(`corrupt:${artifact.id}`), { code: "corrupt" });
			}
			await rename(partial, dest);
			fetched.push(artifact.id);
		}

		progress("Preparing the Python environment");
		const venv = join(input.targetDir, ".venv");
		const python = kokoroVenvPython(input.targetDir);
		let venvReady = false;
		try {
			await stat(python);
			const probed = await run(io, python, ["-c", KOKORO_PYTHON_PROBE], signal);
			venvReady = probed.code === 0 && kokoroPythonSupported(probed.detail ?? "");
		} catch (error) {
			if ((error as Error).message === "cancelled") throw error;
			venvReady = false;
		}
		if (!venvReady) {
			await rm(venv, { recursive: true, force: true });
			const base = await selectBasePython(io, signal);
			const created = await run(io, base, ["-m", "venv", venv], signal);
			if (created.code !== 0) throw Object.assign(new Error("venv_failed"), { detail: created.detail });
		}

		progress("Installing Kokoro");
		const pip = await run(io, python, [
			"-m",
			"pip",
			"install",
			"--no-cache-dir",
			"--disable-pip-version-check",
			"--ignore-requires-python",
			...KOKORO_PIP_REQUIREMENTS,
		], signal);
		if (pip.code !== 0) throw Object.assign(new Error("pip_failed"), { detail: pip.detail });

		progress("Checking the Kokoro voice");
		const model = join(input.targetDir, artifacts.find((a) => a.id === "model")!.relativePath);
		const voices = join(input.targetDir, artifacts.find((a) => a.id === "voices")!.relativePath);
		const probe = await run(io, python, [
			input.workerScript ?? kokoroWorkerScript(),
			"--model",
			model,
			"--voices",
			voices,
			"--lang",
			KOKORO_LANG,
			"--voice",
			KOKORO_DEFAULT_VOICE,
			"--probe",
		], signal);
		if (probe.code !== 0) throw Object.assign(new Error("probe_failed"), { detail: probe.detail });

		await writeFile(
			join(input.targetDir, "integrity.json"),
			`${JSON.stringify({
				kind: KOKORO_INTEGRITY_KIND,
				packages: KOKORO_PIP_REQUIREMENTS,
				artifacts: artifacts.map((a) => ({ path: a.relativePath, bytes: a.bytes, sha256: a.sha256 })),
			}, null, 2)}\n`,
			{ mode: 0o600 },
		);
		writeTtsEnginePreference(input.voiceHome, "kokoro");
		return { status: "installed", reason: "verified", fetched };
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed";
		if (message === "cancelled" || signal.aborted) return { status: "cancelled", reason: "cancelled", fetched };
		const detail = (error as { detail?: string }).detail;
		const code = (error as { code?: string }).code;
		return {
			status: code === "corrupt" ? "corrupt" : "failed",
			reason: message,
			fetched,
			...(detail ? { detail } : {}),
		};
	}
}

export function createKokoroNetworkIo(): KokoroInstallIo {
	const processIo = createNetworkOnboardingIo();
	return {
		async fetch(url, destination, signal) {
			const response = await fetch(url, { signal });
			if (!response.ok || !response.body) throw new Error(`download_failed:${response.status}`);
			const stream = createWriteStream(destination, { mode: 0o600 });
			try {
				const reader = response.body.getReader();
				for (;;) {
					const step = await reader.read();
					if (step.done) break;
					if (signal.aborted) throw new Error("cancelled");
					await new Promise<void>((resolveWrite, reject) => {
						stream.write(Buffer.from(step.value), (error) => (error ? reject(error) : resolveWrite()));
					});
				}
			} finally {
				await new Promise<void>((resolveClose) => stream.end(resolveClose));
			}
		},
		run: (command, args, signal) => processIo.run(command, args, signal),
	};
}
