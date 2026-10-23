/**
 * Silero VAD onboarding. The model is not in the npm package.
 * Nothing is downloaded until the user accepts. Energy VAD stays available.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveGentleVoiceStorage } from "../runtime/storage.ts";
import { createCompactVoiceLeaf, type CompactWidgetLeaf, type VoiceThemeLike } from "../visual/compact-widget.ts";
import { tryCreateSileroVad } from "./silero-vad.ts";

/** Immutable upstream file. Size is the GitHub blob size of this commit. */
export const SILERO_VAD_COMMIT = "1e261b036686cd0017d500ee96acd1c4ba572a9d";
export const SILERO_VAD_BYTES = 2_327_524;
export const SILERO_VAD_URL =
	`https://github.com/snakers4/silero-vad/raw/${SILERO_VAD_COMMIT}/src/silero_vad/data/silero_vad.onnx`;

export const SILERO_VAD_PREFERENCE_KIND = "gentle-voice.vad" as const;

export const SILERO_STEPS = [
	{ id: "check", label: "Checking Silero VAD" },
	{ id: "download", label: "Downloading Silero model" },
	{ id: "verify", label: "Verifying model integrity" },
	{ id: "init", label: "Initializing VAD" },
	{ id: "mic", label: "Verifying microphone capture" },
] as const;

export type SileroStepId = (typeof SILERO_STEPS)[number]["id"];
export type SileroStepState = "pending" | "running" | "completed" | "failed" | "reused" | "skipped";

export interface SileroStep {
	readonly id: SileroStepId;
	readonly label: string;
	readonly state: SileroStepState;
}

const STATE_WORD: Record<SileroStepState, string> = {
	pending: "Pending",
	running: "Running",
	completed: "Completed",
	failed: "Failed",
	reused: "Reused",
	skipped: "Skipped",
};

const STATE_MARK: Record<SileroStepState, string> = {
	pending: "[ ]",
	running: "[>]",
	completed: "[x]",
	failed: "[!]",
	reused: "[=]",
	skipped: "[-]",
};

export type SileroPlan =
	| { readonly status: "ready"; readonly path: string; readonly bytes: number }
	| { readonly status: "missing"; readonly path: string }
	| { readonly status: "corrupt"; readonly path: string; readonly bytes: number }
	| { readonly status: "declined"; readonly path: string };

export interface SileroDriveHost {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	confirm?(title: string, message: string): Promise<boolean>;
	setStatus?(key: string, text: string | undefined): void;
	setWidget?(
		key: string,
		content: unknown,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	captureReady?(): Promise<boolean>;
	/** Platform fix-ups before the microphone check, e.g. the WSLg PipeWire bridge. */
	prepareCapture?(): Promise<void>;
}

export interface SileroInstallIo {
	fetch(dest: string, signal: AbortSignal): Promise<void>;
}

export function sileroModelPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveGentleVoiceStorage({ env }).modelsDir, "silero", "silero_vad.onnx");
}

export function sileroPreferencePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveGentleVoiceStorage({ env }).dataDir, "vad.json");
}

export function readSileroDeclined(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { kind?: string; choice?: string };
		return raw.kind === SILERO_VAD_PREFERENCE_KIND && raw.choice === "energy";
	} catch {
		return false;
	}
}

export async function inspectSileroFile(path: string): Promise<SileroPlan> {
	try {
		const info = await stat(path);
		if (info.size === SILERO_VAD_BYTES) return { status: "ready", path, bytes: info.size };
		return { status: "corrupt", path, bytes: info.size };
	} catch {
		return { status: "missing", path };
	}
}

export async function planSileroInstall(
	env: NodeJS.ProcessEnv = process.env,
): Promise<SileroPlan> {
	const path = sileroModelPath(env);
	if (readSileroDeclined(sileroPreferencePath(env))) return { status: "declined", path };
	return inspectSileroFile(path);
}

export function formatSileroView(steps: readonly SileroStep[]): string[] {
	return ["Silero VAD", ...steps.map((step) => `${STATE_MARK[step.state]} ${step.label}  ${STATE_WORD[step.state]}`)];
}

export function sileroProgressWidget(
	steps: readonly SileroStep[],
): (ui: unknown, theme: VoiceThemeLike) => CompactWidgetLeaf {
	const lines = formatSileroView(steps);
	return (_ui, theme) => createCompactVoiceLeaf(lines.map((line, index) => {
		if (index === 0 || line.includes(" Running")) return theme.fg("accent", line);
		if (line.includes(" Failed")) return theme.fg("error", line);
		if (line.includes(" Pending")) return theme.fg("dim", line);
		return theme.fg("muted", line);
	}));
}

function checklist(): SileroStep[] {
	return SILERO_STEPS.map((step) => ({ ...step, state: "pending" as const }));
}

function mark(steps: SileroStep[], id: SileroStepId, state: SileroStepState): SileroStep[] {
	return steps.map((step) => step.id === id ? { ...step, state } : step);
}

async function writeDeclined(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`${JSON.stringify({
			kind: SILERO_VAD_PREFERENCE_KIND,
			choice: "energy",
			updatedAt: new Date().toISOString(),
		}, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

export async function defaultSileroFetch(dest: string, signal: AbortSignal): Promise<void> {
	const response = await fetch(SILERO_VAD_URL, { signal });
	if (!response.ok) throw new Error(`silero_http_${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.byteLength !== SILERO_VAD_BYTES) {
		throw new Error(`silero_size_${bytes.byteLength}`);
	}
	await mkdir(dirname(dest), { recursive: true });
	const partial = `${dest}.partial`;
	await writeFile(partial, bytes, { mode: 0o600 });
	await rename(partial, dest);
}

/**
 * Offer Silero when the recommended conversation VAD is missing.
 * A decline keeps Energy VAD and is remembered. VibeVoice is not touched.
 */
export async function driveSileroInstall(
	host: SileroDriveHost,
	input: {
		readonly env?: NodeJS.ProcessEnv;
		readonly signal?: AbortSignal;
		readonly io?: SileroInstallIo;
		readonly allowNetwork?: boolean;
		readonly loadVad?: (modelPath: string) => Promise<
			| { readonly ok: true; readonly engine: { dispose?: () => void | Promise<void> } }
			| { readonly ok: false; readonly reason: string }
		>;
	} = {},
): Promise<SileroDriveOutcome> {
	const env = input.env ?? process.env;
	const signal = input.signal ?? new AbortController().signal;
	const key = "gentle-voice-silero";
	let steps = checklist();
	let showProgress = true;
	let painted = false;
	const paint = (status: string) => {
		if (!showProgress) return;
		painted = true;
		host.setStatus?.(key, status);
		host.setWidget?.(key, sileroProgressWidget(steps), { placement: "aboveEditor" });
	};
	const clear = () => {
		if (!painted) return;
		painted = false;
		host.setStatus?.(key, undefined);
		host.setWidget?.(key, undefined);
	};
	const plan = await planSileroInstall(env);
	showProgress = plan.status !== "ready" && plan.status !== "declined";
	steps = mark(steps, "check", "running");
	paint("Checking Silero VAD");
	if (plan.status === "declined") {
		steps = mark(steps, "check", "completed");
		steps = mark(steps, "download", "skipped");
		steps = mark(steps, "verify", "skipped");
		steps = mark(steps, "init", "skipped");
		paint("Silero VAD");
		clear();
		host.notify(
			"Silero VAD was declined earlier. Conversation uses the energy fallback.",
			"info",
		);
		return plan;
	}
	if (plan.status === "ready") {
		steps = mark(steps, "check", "reused");
		steps = mark(steps, "download", "skipped");
	} else {
		steps = mark(steps, "check", plan.status === "corrupt" ? "failed" : "completed");
		if (!host.confirm) {
			clear();
			host.notify(
				"Silero VAD is not installed. Conversation uses the energy fallback until you accept the download.",
				"warning",
			);
			return plan;
		}
		const accepted = await host.confirm(
			"Silero VAD",
			[
				"Conversation mode recommends Silero to detect speech.",
				`Download: ${SILERO_VAD_BYTES} bytes`,
				"License: MIT",
				"Energy VAD stays available if you decline.",
				"Nothing is downloaded until you accept.",
			].join("\n"),
		);
		if (signal.aborted) {
			clear();
			return plan;
		}
		if (!accepted) {
			await writeDeclined(sileroPreferencePath(env));
			steps = mark(steps, "download", "skipped");
			paint("Silero VAD");
			clear();
			host.notify(
				"Silero VAD was not installed. Conversation uses the energy fallback.",
				"warning",
			);
			return { status: "declined", path: plan.path };
		}
		if (input.allowNetwork === false || env.GENTLE_VOICE_DISABLE_DOWNLOADS === "1") {
			steps = mark(steps, "download", "failed");
			paint("Silero VAD");
			clear();
			host.notify("Silero download was not authorized. Energy fallback stays active.", "warning");
			return plan;
		}
		steps = mark(steps, "download", "running");
		paint("Downloading Silero model");
		const dest = plan.path;
		try {
			await (input.io?.fetch ?? defaultSileroFetch)(dest, signal);
		} catch (error) {
			await rm(`${dest}.partial`, { force: true }).catch(() => {});
			steps = mark(steps, "download", "failed");
			paint("Silero VAD");
			clear();
			const message = error instanceof Error ? error.message : "silero_download_failed";
			host.notify(`Silero download failed (${message}). Energy fallback stays active.`, "error");
			return plan;
		}
		steps = mark(steps, "download", "completed");
	}

	steps = mark(steps, "verify", "running");
	paint("Verifying model integrity");
	const verified = await inspectSileroFile(plan.path);
	if (verified.status !== "ready") {
		steps = mark(steps, "verify", "failed");
		paint("Silero VAD");
		clear();
		host.notify(
			`Silero model failed integrity (size ${"bytes" in verified ? verified.bytes : 0}, expected ${SILERO_VAD_BYTES}). Energy fallback stays active.`,
			"error",
		);
		return verified;
	}
	const recorded = createHash("sha256").update(await readFile(plan.path)).digest("hex");
	await writeFile(
		`${plan.path}.sha256`,
		`${recorded}  ${SILERO_VAD_BYTES}\n`,
		{ mode: 0o600 },
	);
	steps = mark(steps, "verify", plan.status === "ready" ? "reused" : "completed");

	steps = mark(steps, "init", "running");
	paint("Initializing VAD");
	const loaded = input.loadVad
		? await input.loadVad(plan.path)
		: await tryCreateSileroVad({ modelPath: plan.path });
	if (!loaded.ok) {
		steps = mark(steps, "init", "failed");
		paint("Silero VAD");
		clear();
		host.notify(
			`Silero did not initialize (${loaded.reason}). The model file was kept. Energy fallback stays active.`,
			"warning",
		);
		return verified;
	}
	await loaded.engine.dispose?.();
	steps = mark(steps, "init", "completed");

	steps = mark(steps, "mic", "running");
	paint("Verifying microphone capture");
	const micOk = host.captureReady ? await host.captureReady() : existsSync("/usr/bin/pw-record");
	steps = mark(steps, "mic", micOk ? "completed" : "failed");
	paint("Silero VAD");
	clear();
	if (!micOk) {
		host.notify("Silero VAD is installed. Microphone capture is not available.", "warning");
		return { ...verified, initialized: true };
	}
	if (showProgress) host.notify("Silero VAD is ready. Conversation can use it on the next listen.", "info");
	return { ...verified, initialized: true };
}

export type SileroDriveOutcome = SileroPlan & { readonly initialized?: boolean };

export interface ConversationReadinessInput {
	readonly tts: string;
	readonly stt: string;
	readonly capture: string;
	readonly playback: string;
	readonly silero: SileroPlan["status"];
	/** Last resolved backend, e.g. "silero" or "energy/silero_model_path_missing". */
	readonly vadBackend: string;
}

/** Honest split. A working TTS engine does not make conversation mode ready. */
export function describeConversationReadiness(input: ConversationReadinessInput): string[] {
	const audioReady = input.tts === "ready"
		&& input.stt === "ready"
		&& input.capture === "ready"
		&& input.playback === "ready";
	const vadReady = input.vadBackend === "silero";
	let degraded = "(none)";
	if (!vadReady) {
		if (input.silero === "declined") {
			degraded = "Silero was declined. Energy fallback is active.";
		} else if (input.silero === "corrupt") {
			degraded = "Silero model failed integrity. Energy fallback is active.";
		} else if (input.silero === "missing") {
			degraded = "Silero model is not installed. Energy fallback is active.";
		} else if (input.vadBackend.startsWith("energy")) {
			degraded = `Silero did not load (${input.vadBackend}). Energy fallback is active.`;
		} else {
			degraded = "Silero file is present. VAD runtime is unverified until the next listen.";
		}
	}
	return [
		`tts.ready=${input.tts}`,
		`stt.ready=${input.stt}`,
		`capture.ready=${input.capture}`,
		`playback.ready=${input.playback}`,
		`vad.model=${input.silero}`,
		`vad.backend=${input.vadBackend}`,
		`vad.ready=${vadReady ? "yes" : "no"}`,
		`conversationModeReady=${audioReady && vadReady ? "yes" : "no"}`,
		`conversation.degraded=${degraded}`,
	];
}
