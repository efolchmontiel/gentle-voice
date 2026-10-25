/**
 * VibeVoice onboarding. Network I/O is injected.
 * The extension calls the network adapter only when
 * GENTLE_VOICE_VIBEVOICE_ALLOW_NETWORK=1. Tests pass a fake fetcher.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { VIBEVOICE_PREFERRED_VOICE } from "../adapters/vibevoice-tts.ts";
import { planVibeVoiceInstall, type VibeVoiceHardwareReport } from "./install-plan.ts";
import {
	VIBEVOICE_ARTIFACTS,
	VIBEVOICE_CODE_COMMIT,
	VIBEVOICE_INTEGRITY_KIND,
	type VibeVoiceArtifact,
} from "./manifest.ts";
import {
	createInstallChecklist,
	type InstallStep,
	type InstallStepId,
	type InstallStepState,
} from "./install-progress.ts";
import {
	VIBEVOICE_PYTHON_CANDIDATES,
	VIBEVOICE_PYTHON_PROBE,
	VIBEVOICE_VENV_READY,
	vibeVoicePythonSupported,
} from "./python-runtime.ts";
import { readTtsEnginePreference, writeTtsEnginePreference } from "./tts-preference.ts";

export interface OnboardingIo {
	fetch(artifact: VibeVoiceArtifact, destination: string, signal: AbortSignal): Promise<void>;
	run(command: string, args: readonly string[], signal: AbortSignal): Promise<{ code: number; detail?: string }>;
	/**
	 * Start the worker and verify a warm synthesis before accepting the install.
	 * Production uses the private Python. Tests can omit it.
	 */
	probeWorker?(
		python: string,
		workerScript: string,
		home: string,
		signal: AbortSignal,
	): Promise<{ code: number; detail?: string }>;
}

export type VibeVoiceInstallPhase =
	| "starting"
	| "verifying"
	| "downloading"
	| "preparing_python"
	| "installing_python"
	| "configuring_voice"
	| "verifying_install";

export const VIBEVOICE_PHASE_TEXT: Record<VibeVoiceInstallPhase, string> = {
	starting: "Installing VibeVoice...",
	verifying: "Downloading model",
	downloading: "Downloading source",
	preparing_python: "Preparing Python environment",
	installing_python: "Installing dependencies",
	configuring_voice: "Installing Spanish voice",
	verifying_install: "Verifying voice engine",
};

/**
 * What the streaming worker imports. Upstream's dependency list also pulls the
 * web demo (gradio, aiortc, av, fastapi, uvicorn) and librosa/numba/scipy,
 * which the worker never loads. `accelerate` backs `device_map`.
 */
export const VIBEVOICE_RUNTIME_REQUIREMENTS: readonly string[] = Object.freeze([
	"torch",
	"transformers==4.51.3",
	"diffusers",
	"accelerate",
	"numpy",
	"tqdm",
]);

/** Pip writes no wheel cache, so PyTorch is not stored a second time under ~/.cache/pip. */
export const VIBEVOICE_PIP_NO_CACHE = "--no-cache-dir";

/** Reads package metadata. It does not import the model or touch the GPU. */
export const VIBEVOICE_DEP_CHECK =
	"import importlib.metadata as m, importlib.util as u; raise SystemExit(0 if m.version('vibevoice') and all(u.find_spec(n) for n in ('torch', 'transformers', 'diffusers', 'accelerate')) else 4)";

export interface VibeVoiceInstallProgress {
	readonly phase: VibeVoiceInstallPhase;
	readonly message: string;
	readonly steps: readonly InstallStep[];
}

export type OnboardingStatus =
	| "reused"
	| "kept_piper"
	| "blocked"
	| "declined"
	| "consent_unavailable"
	| "network_not_authorized"
	| "installed"
	| "cancelled"
	| "corrupt"
	| "partial"
	| "failed";

export interface OnboardingResult {
	readonly status: OnboardingStatus;
	readonly engine: "piper" | "vibevoice";
	readonly voice: typeof VIBEVOICE_PREFERRED_VOICE;
	readonly playback: "pcm";
	readonly targetDir: string;
	readonly reason: string;
	readonly fetched: readonly string[];
	readonly skipped: readonly string[];
	readonly offeredEngine: "piper";
	readonly detail?: string;
}

export function vibeVoiceInside(path: string, root: string): boolean {
	const abs = resolve(path);
	const base = resolve(root);
	return abs === base || abs.startsWith(base.endsWith(sep) ? base : base + sep);
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolveHash, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolveHash());
	});
	return hash.digest("hex");
}

export async function artifactMatches(path: string, artifact: VibeVoiceArtifact): Promise<boolean> {
	try {
		const info = await stat(path);
		if (info.size !== artifact.bytes) return false;
		return (await sha256File(path)) === artifact.sha256;
	} catch {
		return false;
	}
}

function assertNoPrivilege(command: string, args: readonly string[]): void {
	if (command === "sudo" || args.includes("sudo")) {
		throw new Error("sudo_refused");
	}
}

async function selectVibeVoiceBasePython(
	io: OnboardingIo,
	signal: AbortSignal,
): Promise<string> {
	let saw: string | undefined;
	for (const command of VIBEVOICE_PYTHON_CANDIDATES) {
		let probed: { code: number; detail?: string };
		try {
			probed = await io.run(command, ["-c", VIBEVOICE_PYTHON_PROBE], signal);
		} catch {
			continue;
		}
		if (probed.code !== 0) continue;
		if (probed.detail) saw = probed.detail.trim();
		if (vibeVoicePythonSupported(probed.detail ?? "")) return command;
	}
	throw Object.assign(new Error("python_unsupported"), {
		detail: saw
			? `PyTorch publishes Linux wheels for Python 3.10 through 3.14. Found ${saw}.`
			: "PyTorch publishes Linux wheels for Python 3.10 through 3.14. No matching interpreter was found.",
	});
}

function assertPrivateTool(command: string, targetDir: string): void {
	if (!isAbsolute(command)) return;
	if (!vibeVoiceInside(command, join(targetDir, ".venv"))) {
		throw new Error("python_not_private");
	}
}

async function placeArtifact(
	artifact: VibeVoiceArtifact,
	targetDir: string,
	io: OnboardingIo,
	signal: AbortSignal,
): Promise<"fetched" | "skipped"> {
	const dest = join(targetDir, artifact.relativePath);
	if (!vibeVoiceInside(dest, targetDir)) throw new Error("path_escapes");
	if (await artifactMatches(dest, artifact)) return "skipped";
	if (artifact.layout === "repo") {
		await io.fetch(artifact, dest, signal);
		if (!(await artifactMatches(dest, artifact))) {
			await rm(dirname(dest), { recursive: true, force: true });
			throw Object.assign(new Error(`corrupt:${artifact.id}`), { code: "corrupt" });
		}
		return "fetched";
	}
	const partial = `${dest}.partial`;
	await mkdir(dirname(dest), { recursive: true });
	try {
		await io.fetch(artifact, partial, signal);
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
	if (!(await artifactMatches(partial, artifact))) {
		await rm(partial, { force: true });
		throw Object.assign(new Error(`corrupt:${artifact.id}`), { code: "corrupt" });
	}
	await rename(partial, dest);
	return "fetched";
}

export async function runVibeVoiceOnboarding(input: {
	readonly targetDir: string;
	readonly voiceHome: string;
	readonly hardware: VibeVoiceHardwareReport;
	readonly alreadyInstalled: boolean;
	readonly consent: boolean | undefined;
	readonly allowNetwork: boolean;
	readonly allowTmpfs?: boolean;
	readonly signal?: AbortSignal;
	readonly io?: OnboardingIo;
	readonly artifacts?: readonly VibeVoiceArtifact[];
	readonly onProgress?: (progress: VibeVoiceInstallProgress) => void;
}): Promise<OnboardingResult> {
	const signal = input.signal ?? new AbortController().signal;
	const artifacts = input.artifacts ?? VIBEVOICE_ARTIFACTS;
	const base = {
		voice: VIBEVOICE_PREFERRED_VOICE,
		playback: "pcm" as const,
		targetDir: input.targetDir,
		fetched: [] as string[],
		skipped: [] as string[],
		offeredEngine: "piper" as const,
	};
	const stored = readTtsEnginePreference(input.voiceHome);
	if (input.alreadyInstalled) {
		if (stored === "piper") {
			return { ...base, status: "kept_piper", engine: "piper", reason: "explicit_piper" };
		}
		writeTtsEnginePreference(input.voiceHome, "vibevoice");
		return { ...base, status: "reused", engine: "vibevoice", reason: "existing_engine" };
	}
	const plan = planVibeVoiceInstall({
		targetDir: input.targetDir,
		hardware: input.hardware,
		alreadyInstalled: false,
		allowTmpfs: input.allowTmpfs,
	});
	if (plan.status === "blocked") {
		return { ...base, status: "blocked", engine: "piper", reason: plan.reasons.join(",") };
	}
	if (input.consent === undefined) {
		return { ...base, status: "consent_unavailable", engine: "piper", reason: "confirm_required" };
	}
	if (!input.consent) {
		return { ...base, status: "declined", engine: "piper", reason: "user_declined" };
	}
	if (!input.allowNetwork || !input.io) {
		return { ...base, status: "network_not_authorized", engine: "piper", reason: "network_not_authorized" };
	}
	if (signal.aborted) {
		return { ...base, status: "cancelled", engine: "piper", reason: "cancelled" };
	}

	const io = input.io;
	const fetched: string[] = [];
	const skipped: string[] = [];
	const matched = new Set<string>();
	const checklist = createInstallChecklist();
	const phaseFor = (id: InstallStepId): VibeVoiceInstallPhase => {
		if (id === "source") return "downloading";
		if (id === "python") return "preparing_python";
		if (id === "dependencies") return "installing_python";
		if (id === "spanish") return "configuring_voice";
		if (id === "engine" || id === "activate") return "verifying_install";
		return "verifying";
	};
	const emit = (message: string, phase: VibeVoiceInstallPhase = "starting"): void => {
		input.onProgress?.({ phase, message, steps: checklist.snapshot() });
	};
	const mark = (id: InstallStepId, state: InstallStepState): void => {
		checklist.mark(id, state);
		const running = checklist.snapshot().find((step) => step.state === "running");
		emit(running?.label ?? "Installing VibeVoice...", running ? phaseFor(running.id) : "starting");
	};
	const cancelled = (): OnboardingResult => ({
		...base,
		status: "cancelled",
		engine: "piper",
		reason: "cancelled",
		fetched,
		skipped,
	});
	const matches = async (artifact: VibeVoiceArtifact): Promise<boolean> => {
		if (matched.has(artifact.id)) return true;
		const ok = await artifactMatches(join(input.targetDir, artifact.relativePath), artifact);
		if (ok) matched.add(artifact.id);
		return ok;
	};
	const obtain = async (artifact: VibeVoiceArtifact): Promise<"fetched" | "skipped"> => {
		if (await matches(artifact)) {
			if (!skipped.includes(artifact.id)) skipped.push(artifact.id);
			return "skipped";
		}
		if (signal.aborted) throw new Error("cancelled");
		const outcome = await placeArtifact(artifact, input.targetDir, io, signal);
		if (outcome === "fetched") fetched.push(artifact.id);
		else if (!skipped.includes(artifact.id)) skipped.push(artifact.id);
		matched.add(artifact.id);
		return outcome;
	};
	try {
		emit("Installing VibeVoice...");
		const find = (id: VibeVoiceArtifact["id"]): VibeVoiceArtifact | undefined => artifacts.find((artifact) => artifact.id === id);
		const modelFiles = [find("weights"), find("model-config"), find("model-preprocessor")]
			.filter((artifact): artifact is VibeVoiceArtifact => Boolean(artifact));
		mark("weights", "running");
		let modelFetched = false;
		for (const artifact of modelFiles) {
			if (signal.aborted) return cancelled();
			const outcome = await obtain(artifact);
			if (outcome === "fetched") modelFetched = true;
		}
		mark("weights", modelFiles.length === 0 ? "skipped" : modelFetched ? "completed" : "reused");
		const sourceFiles = [find("code-license"), find("code-project")]
			.filter((artifact): artifact is VibeVoiceArtifact => Boolean(artifact));
		const missingSource: VibeVoiceArtifact[] = [];
		for (const artifact of sourceFiles) {
			if (signal.aborted) return cancelled();
			if (await matches(artifact)) {
				if (!skipped.includes(artifact.id)) skipped.push(artifact.id);
			} else missingSource.push(artifact);
		}
		let sourceFetched = false;
		if (missingSource.length === 0) {
			mark("source", sourceFiles.length === 0 ? "skipped" : "reused");
		} else {
			mark("source", "running");
			for (const artifact of missingSource) {
				const outcome = await obtain(artifact);
				if (outcome === "fetched") sourceFetched = true;
			}
			mark("source", "completed");
		}
		mark("python", "running");
		const venv = join(input.targetDir, ".venv");
		const python = join(venv, "bin", "python");
		const pip = join(venv, "bin", "pip");
		let pythonReady = false;
		try {
			await stat(python);
			await stat(pip);
			const checked = await io.run(python, ["-c", VIBEVOICE_VENV_READY], signal);
			pythonReady = checked.code === 0;
		} catch {
			pythonReady = false;
		}
		if (!pythonReady) {
			await rm(venv, { recursive: true, force: true });
			const base = await selectVibeVoiceBasePython(io, signal);
			assertNoPrivilege(base, ["-m", "venv", venv]);
			const created = await io.run(base, ["-m", "venv", venv], signal);
			if (created.code !== 0) throw new Error("venv_failed");
			const checked = await io.run(python, ["-c", VIBEVOICE_VENV_READY], signal);
			if (checked.code !== 0) throw new Error("python_not_private");
			mark("python", "completed");
		} else mark("python", "reused");
		assertPrivateTool(python, input.targetDir);
		assertPrivateTool(pip, input.targetDir);
		mark("dependencies", "running");
		const depArgs = ["-c", VIBEVOICE_DEP_CHECK];
		let dependencies = await io.run(python, depArgs, signal);
		if (dependencies.code !== 0) {
			const pipSteps: readonly (readonly string[])[] = [
				["install", VIBEVOICE_PIP_NO_CACHE, "--no-deps", "-e", join(input.targetDir, "code")],
				["install", VIBEVOICE_PIP_NO_CACHE, ...VIBEVOICE_RUNTIME_REQUIREMENTS],
			];
			for (const pipArgs of pipSteps) {
				assertNoPrivilege(pip, pipArgs);
				const installed = await io.run(pip, pipArgs, signal);
				if (signal.aborted) throw new Error("cancelled");
				if (installed.code !== 0) {
					throw Object.assign(new Error("pip_failed"), { detail: installed.detail });
				}
			}
			dependencies = await io.run(python, depArgs, signal);
			if (dependencies.code !== 0) {
				throw Object.assign(new Error("verify_failed"), { detail: dependencies.detail });
			}
			mark("dependencies", "completed");
		} else mark("dependencies", "reused");
		mark("spanish", "running");
		const voice = find("spanish-voice");
		if (!voice) mark("spanish", "skipped");
		else {
			const already = await matches(voice);
			if (!already) {
				const outcome = await obtain(voice);
				mark("spanish", outcome === "fetched" ? "completed" : "reused");
			} else if (sourceFetched) {
				mark("spanish", "completed");
			} else {
				if (!skipped.includes(voice.id)) skipped.push(voice.id);
				mark("spanish", "reused");
			}
		}
		mark("engine", "running");
		const worker = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/vibevoice-lab-worker.py");
		if (io.probeWorker) {
			const probed = await io.probeWorker(python, worker, input.targetDir, signal);
			if (signal.aborted) throw new Error("cancelled");
			if (probed.code !== 0) {
				throw Object.assign(new Error("worker_probe_failed"), { detail: probed.detail });
			}
		} else if (!existsSync(worker)) throw new Error("worker_script_missing");
		for (const artifact of artifacts) {
			if (!(await matches(artifact))) throw new Error(`verify_failed:${artifact.id}`);
		}
		mark("engine", "completed");
		const receipt = {
			kind: VIBEVOICE_INTEGRITY_KIND,
			commit: VIBEVOICE_CODE_COMMIT,
			artifacts: artifacts.map((artifact) => ({
				path: artifact.relativePath,
				bytes: artifact.bytes,
				sha256: artifact.sha256,
			})),
		};
		const receiptPath = join(input.targetDir, "integrity.json");
		await mkdir(input.targetDir, { recursive: true });
		await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		await writeFile(
			join(input.targetDir, "INSTALL_PENDING.json"),
			`${JSON.stringify({ authorized: true, status: "installed" }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		// Every member is extracted and verified; the source archive is no longer needed.
		await rm(join(input.targetDir, ".download-cache"), { recursive: true, force: true });
		writeTtsEnginePreference(input.voiceHome, "vibevoice");
		return {
			...base,
			status: "installed",
			engine: "vibevoice",
			reason: "verified",
			fetched,
			skipped,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed";
		const detail = (error as { detail?: string }).detail;
		if (message === "cancelled" || signal.aborted) {
			return { ...base, status: "cancelled", engine: "piper", reason: "cancelled", fetched, skipped };
		}
		const running = checklist.snapshot().find((step) => step.state === "running");
		if (running) mark(running.id, "failed");
		const code = (error as { code?: string }).code;
		const status = code === "corrupt" ? "corrupt" : fetched.length + skipped.length > 0 ? "partial" : "failed";
		return {
			...base,
			status,
			engine: "piper",
			reason: message,
			fetched,
			skipped,
			...(detail ? { detail } : {}),
		};
	}
}

export async function uninstallVibeVoiceEngine(input: {
	readonly targetDir: string;
	readonly confirmToken?: string;
	readonly artifacts?: readonly VibeVoiceArtifact[];
}): Promise<{ deleted: boolean; reason: string }> {
	if (input.confirmToken !== "UNINSTALL_VIBEVOICE") return { deleted: false, reason: "confirm_required" };
	const receiptPath = join(input.targetDir, "integrity.json");
	let receipt: { kind?: string } | undefined;
	try {
		receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { kind?: string };
	} catch {
		return { deleted: false, reason: "receipt_missing" };
	}
	if (receipt.kind !== VIBEVOICE_INTEGRITY_KIND) return { deleted: false, reason: "receipt_missing" };
	const artifacts = input.artifacts ?? VIBEVOICE_ARTIFACTS;
	const paths = [
		...artifacts.map((artifact) => artifact.relativePath),
		"integrity.json",
		"INSTALL_PENDING.json",
	];
	for (const rel of paths) {
		const abs = join(input.targetDir, rel);
		if (!vibeVoiceInside(abs, input.targetDir)) return { deleted: false, reason: "path_escapes" };
		const relCheck = relative(input.targetDir, abs);
		if (relCheck.startsWith("..") || isAbsolute(relCheck)) return { deleted: false, reason: "path_escapes" };
		await rm(abs, { force: true });
	}
	const venv = join(input.targetDir, ".venv");
	if (vibeVoiceInside(venv, input.targetDir)) await rm(venv, { recursive: true, force: true });
	return { deleted: true, reason: "removed_known_files" };
}
