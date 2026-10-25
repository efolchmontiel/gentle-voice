/**
 * VibeVoice Realtime TTS — keep-alive worker with explicit FSM.
 *
 * - Default onColdStart=wait: never silent-swap to Piper while loading.
 * - Esc cancels the pending request (discard audio) but keeps the CUDA model resident.
 * - READY only after hello + warmup handshake from the worker.
 * - Playback is native PCM when compatible; WAV is the explicit fallback.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { access, constants, mkdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AdapterAvailability, AudioChunk, TtsAdapter, TtsResult } from "../contracts.ts";
import { AbortError, onAbort, throwIfAborted } from "../process-cancel.ts";
import { isGentleVoiceLabPathsAllowed } from "../runtime/lab-gate.ts";
import { resolveGentleVoiceStorage } from "../runtime/storage.ts";
import { isWavBuffer } from "./wav.ts";
import {
	decodeVibeVoicePcmLine,
	nativeVibeVoiceStreamEnabled,
	type VibeVoicePcmFrame,
} from "./vibevoice-pcm.ts";

export const VIBEVOICE_TTS_ID = "vibevoice" as const;
export const VIBEVOICE_PREFERRED_VOICE = "sp-Spk0_woman" as const;
export const VIBEVOICE_ENGLISH_VOICE = "en-Emma_woman" as const;
export const VIBEVOICE_MODEL_SAFETENSORS_BYTES = 2_035_332_888;
export const VIBEVOICE_SAMPLE_RATE_HZ = 24_000;

export type VibeVoiceWorkerState =
	| "STOPPED"
	| "STARTING"
	| "LOADING"
	| "WARMING"
	| "READY"
	| "SYNTHESIZING"
	| "ERROR"
	| "STOPPING";

export type VibeVoiceOnColdStart = "wait" | "piper";

const EMPTY_PCM: AudioChunk = Object.freeze({
	bytes: new Uint8Array(0),
	sampleRateHz: VIBEVOICE_SAMPLE_RATE_HZ,
	channels: 1,
	format: "wav" as const,
});

export function resolveVibeVoiceOnColdStart(
	env: NodeJS.ProcessEnv = process.env,
): VibeVoiceOnColdStart {
	const raw = (env.GENTLE_VOICE_TTS_ON_COLD_START ?? "wait").trim().toLowerCase();
	return raw === "piper" ? "piper" : "wait";
}

export function resolveVibeVoiceHome(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.GENTLE_VOICE_VIBEVOICE_HOME?.trim();
	if (explicit) return explicit;
	const voiceHome = env.GENTLE_VOICE_HOME?.trim();
	if (voiceHome) return join(voiceHome, "vibevoice");
	return join(resolveGentleVoiceStorage({ env }).dataDir, "vibevoice");
}

/** Directory `from_pretrained` reads. A weights file is accepted; its parent is not. */
export function vibeVoiceWorkerModelDir(modelPath: string): string {
	const base = basename(modelPath);
	if (base === "model.safetensors" || base === "pytorch_model.bin") return dirname(modelPath);
	return modelPath;
}

function resolveModelDir(home: string): string | undefined {
	const nested = join(home, "models", "VibeVoice-Realtime-0.5B");
	const flat = join(home, "models");
	if (existsSync(join(nested, "model.safetensors"))) return nested;
	if (existsSync(join(flat, "model.safetensors"))) return flat;
	return undefined;
}

function resolveVoicePt(home: string, voiceId: string): string | undefined {
	const candidates = [
		join(home, "code", "demo", "voices", "streaming_model", `${voiceId}.pt`),
		join(home, "voices", `${voiceId}.pt`),
	];
	return candidates.find((p) => existsSync(p));
}

function resolveWorkerScript(home: string): string | undefined {
	const packaged = join(
		dirname(fileURLToPath(import.meta.url)),
		"../../scripts/vibevoice-lab-worker.py",
	);
	const candidates = [
		join(home, "scripts", "lab_worker.py"),
		packaged,
	];
	return candidates.find((p) => existsSync(p));
}

export interface VibeVoiceReadiness {
	readonly ready: boolean;
	readonly home: string;
	readonly reason: string;
	readonly modelPath?: string;
	readonly modelBytes?: number;
	readonly voice?: string;
	readonly voicePt?: string;
	readonly venvPython?: string;
	readonly workerScript?: string;
}

export function probeVibeVoiceReadiness(
	env: NodeJS.ProcessEnv = process.env,
): VibeVoiceReadiness {
	const home = resolveVibeVoiceHome(env);
	const markerPath = join(home, "INSTALL_PENDING.json");
	const venvPython = join(home, ".venv", "bin", "python");
	const voice = env.GENTLE_VOICE_VIBEVOICE_VOICE?.trim() || VIBEVOICE_PREFERRED_VOICE;
	const workerScript = resolveWorkerScript(home);

	if (!existsSync(home)) {
		return { ready: false, home, reason: "home_missing", voice };
	}

	let authorized = false;
	if (existsSync(markerPath)) {
		try {
			const raw = JSON.parse(readFileSync(markerPath, "utf8")) as {
				authorized?: boolean;
				status?: string;
			};
			authorized = raw.authorized === true && raw.status === "installed";
		} catch {
			authorized = false;
		}
	}
	if (!authorized) {
		return { ready: false, home, reason: "awaiting_user_authorization", voice };
	}
	if (!existsSync(venvPython)) {
		return { ready: false, home, reason: "venv_missing", voice };
	}
	const modelDir = resolveModelDir(home);
	if (!modelDir) {
		return { ready: false, home, reason: "model_missing", voice };
	}
	const modelPath = join(modelDir, "model.safetensors");
	let modelBytes = 0;
	try {
		modelBytes = statSync(modelPath).size;
	} catch {
		return { ready: false, home, reason: "model_stat_failed", voice, modelPath };
	}
	if (modelBytes !== VIBEVOICE_MODEL_SAFETENSORS_BYTES) {
		return {
			ready: false,
			home,
			reason: `model_size_mismatch:${modelBytes}`,
			voice,
			modelPath,
			modelBytes,
		};
	}
	if (!existsSync(join(modelDir, "config.json")) || !existsSync(join(modelDir, "preprocessor_config.json"))) {
		return {
			ready: false,
			home,
			reason: "model_config_missing",
			voice,
			modelPath,
			modelBytes,
		};
	}
	const voicePt = resolveVoicePt(home, voice);
	if (!voicePt) {
		return { ready: false, home, reason: "voice_missing", voice, modelPath, modelBytes };
	}
	if (!workerScript) {
		return {
			ready: false,
			home,
			reason: "worker_script_missing",
			voice,
			modelPath,
			modelBytes,
			voicePt,
			venvPython,
		};
	}
	return {
		ready: true,
		home,
		reason: "ready",
		modelPath: modelDir,
		modelBytes,
		voice,
		voicePt,
		venvPython,
		workerScript,
	};
}

export function isVibeVoiceReady(env: NodeJS.ProcessEnv = process.env): boolean {
	return probeVibeVoiceReadiness(env).ready;
}

export function labVibeVoicePresent(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!isGentleVoiceLabPathsAllowed(env)) return false;
	return isVibeVoiceReady(env);
}

export interface VibeVoiceLoadTimeline {
	readonly import_sec?: number;
	readonly cuda_context_sec?: number;
	readonly processor_sec?: number;
	readonly model_load_sec?: number;
	readonly voice_load_sec?: number;
	readonly warmup_sec?: number;
	readonly load_total_sec?: number;
	readonly vram_ready_mb?: number;
}

export interface VibeVoiceMetrics {
	readonly synthesizeMs: number;
	readonly loadMs?: number;
	readonly generateSec?: number;
	readonly vramPeakMb?: number;
	readonly outputBytes: number;
	readonly sampleRateHz: number;
	readonly durationSec: number;
	readonly textChars: number;
	readonly workerWarm: boolean;
	readonly streamingMode: "batch_generate" | "incremental_pcm";
	readonly timeline?: VibeVoiceLoadTimeline;
}

export interface VibeVoiceTtsAdapterOptions {
	readonly voice?: string;
	readonly dryRun?: boolean;
	readonly timeoutMs?: number;
	readonly tmpDir?: string;
	readonly keepTemp?: boolean;
	readonly env?: NodeJS.ProcessEnv;
	readonly onColdStart?: VibeVoiceOnColdStart;
	readonly onState?: (state: VibeVoiceWorkerState) => void;
}

export interface VibeVoiceTtsAdapter extends TtsAdapter {
	readonly lastMetrics: VibeVoiceMetrics | undefined;
	readonly workerState: VibeVoiceWorkerState;
	readonly workerWarm: boolean;
	readonly lastTimeline: VibeVoiceLoadTimeline | undefined;
	readonly onColdStart: VibeVoiceOnColdStart;
	prewarm(): Promise<void>;
	dispose(): Promise<void>;
	/** True when LOADING/WARMING/STARTING — chrome should show VOICE_LOADING. */
	readonly isLoadingVoice: boolean;
}

type Pending = {
	resolve: (msg: Record<string, unknown>) => void;
	reject: (err: Error) => void;
	/** When true, result is discarded (Esc) but worker stays alive. */
	cancelled: boolean;
	onPcm?: (frame: VibeVoicePcmFrame) => void | Promise<void>;
	pcmSeq?: number;
};

/** A failed engine boot cannot be repaired by changing PCM to WAV. */
export class VibeVoiceWorkerStartupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VibeVoiceWorkerStartupError";
	}
}

class VibeVoiceWorkerClient {
	#proc: ChildProcessWithoutNullStreams | undefined;
	#pending = new Map<string, Pending>();
	#hello: Record<string, unknown> | undefined;
	#timeline: VibeVoiceLoadTimeline | undefined;
	#starting: Promise<void> | undefined;
	#stderr = "";
	#state: VibeVoiceWorkerState = "STOPPED";
	#busySynth = false;
	#lineChain: Promise<void> = Promise.resolve();
	readonly probe: VibeVoiceReadiness;
	readonly onState?: (state: VibeVoiceWorkerState) => void;

	constructor(probe: VibeVoiceReadiness, onState?: (state: VibeVoiceWorkerState) => void) {
		this.probe = probe;
		this.onState = onState;
	}

	get state(): VibeVoiceWorkerState {
		return this.#state;
	}

	get warm(): boolean {
		return this.#state === "READY" || this.#state === "SYNTHESIZING";
	}

	get timeline(): VibeVoiceLoadTimeline | undefined {
		return this.#timeline;
	}

	#setState(s: VibeVoiceWorkerState): void {
		this.#state = s;
		try {
			this.onState?.(s);
		} catch {
			/* chrome hooks must never break TTS */
		}
	}

	async ensureStarted(): Promise<void> {
		if (this.warm && this.#proc && !this.#proc.killed) return;
		if (this.#starting) return this.#starting;
		this.#starting = this.#start();
		try {
			await this.#starting;
		} finally {
			this.#starting = undefined;
		}
	}

	async #start(): Promise<void> {
		const { venvPython, workerScript, home, modelPath, voicePt } = this.probe;
		if (!venvPython || !workerScript || !modelPath || !voicePt) {
			throw new Error("vibevoice worker paths incomplete");
		}

		// Only kill a previous broken process — never on Esc cancel.
		if (this.#proc) {
			this.killHard();
		}

		this.#setState("STARTING");
		this.#hello = undefined;
		this.#timeline = undefined;
		this.#stderr = "";

		const env: NodeJS.ProcessEnv = {
			...process.env,
			GENTLE_VOICE_VIBEVOICE_HOME: home,
			GENTLE_VOICE_VIBEVOICE_MODEL: vibeVoiceWorkerModelDir(modelPath),
			GENTLE_VOICE_VIBEVOICE_VOICE_PT: voicePt,
			GENTLE_VOICE_VIBEVOICE_DTYPE: process.env.GENTLE_VOICE_VIBEVOICE_DTYPE?.trim() || "auto",
			HF_HOME: join(home, "cache", "huggingface"),
			TRANSFORMERS_CACHE: join(home, "cache", "huggingface"),
			TORCH_HOME: join(home, "cache", "torch"),
			PYTHONUNBUFFERED: "1",
		};

		const proc = spawn(venvPython, [workerScript], {
			cwd: join(home, "code"),
			env,
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		this.#proc = proc;

		proc.stderr.on("data", (c: Buffer) => {
			this.#stderr += c.toString("utf8");
			if (this.#stderr.length > 8_000) this.#stderr = this.#stderr.slice(-4_000);
		});

		const rl = createInterface({ input: proc.stdout });
		rl.on("line", (line) => {
			this.#lineChain = this.#lineChain.then(() => this.#onLine(line)).catch(() => {});
		});

		proc.once("close", async (code, signal) => {
			// stdout's structured load error must be handled before a generic exit.
			await this.#lineChain;
			if (this.#proc !== proc) return;
			const message = `vibevoice worker exited (code=${code}, signal=${signal ?? "none"})${this.#stderr.trim() ? `: ${this.#stderr.trim().slice(-600)}` : ""}`;
			const err = this.#hello ? new Error(message) : new VibeVoiceWorkerStartupError(message);
			for (const [, p] of this.#pending) {
				if (!p.cancelled) p.reject(err);
			}
			this.#pending.clear();
			this.#hello = undefined;
			this.#proc = undefined;
			this.#busySynth = false;
			this.#setState("STOPPED");
		});

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete("__boot__");
				reject(new VibeVoiceWorkerStartupError("vibevoice worker hello timeout (120s)"));
				this.killHard();
			}, 120_000);
			this.#pending.set("__boot__", {
				cancelled: false,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			proc.once("error", (e) => {
				clearTimeout(timer);
				this.#pending.delete("__boot__");
				reject(e);
			});
		});
	}

	async #onLine(line: string): Promise<void> {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		const op = msg.op;
		if (op === "state" && typeof msg.state === "string") {
			this.#setState(msg.state as VibeVoiceWorkerState);
			return;
		}
		if (op === "timeline" && msg.phase === "warmup_done") {
			this.#timeline = msg as unknown as VibeVoiceLoadTimeline;
		}
		if (op === "hello") {
			this.#hello = msg;
			if (msg.timeline && typeof msg.timeline === "object") {
				this.#timeline = msg.timeline as VibeVoiceLoadTimeline;
			}
			this.#setState("READY");
			const boot = this.#pending.get("__boot__");
			if (boot) {
				this.#pending.delete("__boot__");
				boot.resolve(msg);
			}
			return;
		}
		if (op === "error" && !msg.req_id && this.#pending.has("__boot__")) {
			const boot = this.#pending.get("__boot__")!;
			this.#pending.delete("__boot__");
			this.#setState("ERROR");
			boot.reject(new VibeVoiceWorkerStartupError(String(msg.error ?? "vibevoice_load_failed")));
			return;
		}
		const reqId = typeof msg.req_id === "string" ? msg.req_id : "";
		if (!reqId || !this.#pending.has(reqId)) return;
		const p = this.#pending.get(reqId)!;
		if (op === "pcm") {
			if (p.cancelled) return;
			const decoded = decodeVibeVoicePcmLine(msg, p.pcmSeq ?? 0);
			if (!decoded.ok) {
				p.cancelled = true;
				p.reject(new Error(`vibevoice_pcm_${decoded.reason}`));
				return;
			}
			p.pcmSeq = decoded.nextSeq;
			await p.onPcm?.(decoded.frame);
			return;
		}
		if (op === "cancel_ack") return;
		this.#pending.delete(reqId);
		this.#busySynth = false;
		if (p.cancelled) {
			// Esc discarded — worker stays READY; delete orphan wav if any.
			const wav = typeof msg.out_wav === "string" ? msg.out_wav : "";
			if (wav) void unlink(wav).catch(() => {});
			return;
		}
		if (op === "error") {
			p.reject(new Error(String(msg.error ?? "vibevoice_worker_error")));
		} else {
			p.resolve(msg);
		}
	}

	async request(
		payload: Record<string, unknown>,
		signal: AbortSignal,
		timeoutMs: number,
		onPcm?: (frame: VibeVoicePcmFrame) => void | Promise<void>,
	): Promise<Record<string, unknown>> {
		await this.ensureStarted();
		throwIfAborted(signal);
		const proc = this.#proc;
		if (!proc || !proc.stdin.writable) {
			throw new Error("vibevoice worker not writable");
		}
		// Serialize synths: wait until previous finishes (including discarded).
		const waitBusyDeadline = Date.now() + timeoutMs;
		while (this.#busySynth && Date.now() < waitBusyDeadline) {
			throwIfAborted(signal);
			await new Promise((r) => setTimeout(r, 50));
		}
		throwIfAborted(signal);

		const reqId = String(payload.req_id ?? randomUUID());
		const line = JSON.stringify({ ...payload, req_id: reqId }) + "\n";
		this.#busySynth = true;

		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				const p = this.#pending.get(reqId);
				if (p) {
					p.cancelled = true;
					this.#pending.delete(reqId);
				}
				this.#busySynth = false;
				reject(new Error(`vibevoice synth timeout (${timeoutMs}ms)`));
			}, timeoutMs);

			const pending: Pending = {
				cancelled: false,
				pcmSeq: 0,
				...(onPcm ? { onPcm } : {}),
				resolve: (msg) => {
					detach();
					clearTimeout(timer);
					resolve(msg);
				},
				reject: (err) => {
					detach();
					clearTimeout(timer);
					reject(err);
				},
			};
			this.#pending.set(reqId, pending);

			const detach = onAbort(signal, () => {
				// Soft cancel: keep worker + model; keep pending so result clears busySynth.
				pending.cancelled = true;
				clearTimeout(timer);
				try {
					proc.stdin.write(JSON.stringify({ op: "cancel", req_id: reqId }) + "\n");
				} catch {
					/* worker may already be idle */
				}
				reject(new AbortError());
				// Result handler will discard audio and clear busy when worker finishes.
			});

			try {
				proc.stdin.write(line);
			} catch (e) {
				this.#pending.delete(reqId);
				this.#busySynth = false;
				detach();
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	/** Hard kill — dispose / fatal only. Esc must NOT call this. */
	killHard(): void {
		const proc = this.#proc;
		this.#proc = undefined;
		this.#hello = undefined;
		this.#busySynth = false;
		for (const [, p] of this.#pending) {
			if (!p.cancelled) p.reject(new Error("vibevoice worker killed"));
		}
		this.#pending.clear();
		this.#setState("STOPPING");
		if (proc && !proc.killed) {
			try {
				proc.stdin.write(JSON.stringify({ op: "shutdown" }) + "\n");
			} catch {
				/* ignore */
			}
			proc.kill("SIGKILL");
		}
		this.#setState("STOPPED");
	}

	async dispose(): Promise<void> {
		const proc = this.#proc;
		if (!proc) {
			this.#setState("STOPPED");
			return;
		}
		this.#setState("STOPPING");
		try {
			proc.stdin.write(JSON.stringify({ op: "shutdown" }) + "\n");
		} catch {
			/* ignore */
		}
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
				resolve();
			}, 1500);
			proc.once("exit", () => {
				clearTimeout(t);
				resolve();
			});
		});
		this.#proc = undefined;
		this.#hello = undefined;
		this.#busySynth = false;
		this.#pending.clear();
		this.#setState("STOPPED");
	}
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function createVibeVoiceTtsAdapter(
	options: VibeVoiceTtsAdapterOptions = {},
): VibeVoiceTtsAdapter {
	const env = options.env ?? process.env;
	const voice = options.voice ?? env.GENTLE_VOICE_VIBEVOICE_VOICE?.trim() ?? VIBEVOICE_PREFERRED_VOICE;
	const dryRun = options.dryRun === true;
	const timeoutMs = options.timeoutMs ?? 180_000;
	const tmpDir = options.tmpDir ?? join(tmpdir(), "gentle-voice");
	const keepTemp = options.keepTemp === true;
	const onColdStart = options.onColdStart ?? resolveVibeVoiceOnColdStart(env);

	let lastMetrics: VibeVoiceMetrics | undefined;
	let client: VibeVoiceWorkerClient | undefined;
	let loadMsOnce: number | undefined;

	const getClient = (probe: VibeVoiceReadiness): VibeVoiceWorkerClient => {
		if (!client) {
			client = new VibeVoiceWorkerClient(probe, options.onState);
		}
		return client;
	};

	const adapter: VibeVoiceTtsAdapter = {
		id: VIBEVOICE_TTS_ID,
		onColdStart,
		get lastMetrics() {
			return lastMetrics;
		},
		get workerState() {
			return client?.state ?? "STOPPED";
		},
		get workerWarm() {
			return Boolean(client?.warm);
		},
		get lastTimeline() {
			return client?.timeline;
		},
		get isLoadingVoice() {
			const s = client?.state;
			return s === "STARTING" || s === "LOADING" || s === "WARMING";
		},
		async dispose() {
			if (client) {
				await client.dispose();
				client = undefined;
			}
		},
		async prewarm(): Promise<void> {
			if (dryRun) return;
			const probe = probeVibeVoiceReadiness(env);
			if (!probe.ready) return;
			try {
				await getClient(probe).ensureStarted();
				if (loadMsOnce === undefined && client?.timeline?.load_total_sec != null) {
					loadMsOnce = Math.round(client.timeline.load_total_sec * 1000);
				}
			} catch {
				client = undefined;
			}
		},
		async availability(): Promise<AdapterAvailability> {
			const probe = probeVibeVoiceReadiness(env);
			if (!probe.ready) {
				return { status: "unavailable", reason: probe.reason };
			}
			if (!(await isExecutable(probe.venvPython!))) {
				return { status: "unavailable", reason: "venv_python_not_executable" };
			}
			const warm = Boolean(client?.warm);
			return {
				status: "ready",
				detail: dryRun
					? `vibevoice dry-run voice=${voice}`
					: `vibevoice ${voice} state=${client?.state ?? "STOPPED"} cold=${onColdStart}${warm ? " warm" : ""}`,
			};
		},
		async synthesize(text, options): Promise<TtsResult> {
			const signal = options.signal;
			const streamPcm = Boolean(options.onPcm) && nativeVibeVoiceStreamEnabled(env);
			throwIfAborted(signal);
			const trimmed = text.trim();
			if (!trimmed) return { audio: EMPTY_PCM };
			if (dryRun) {
				lastMetrics = {
					synthesizeMs: 0,
					outputBytes: 0,
					sampleRateHz: VIBEVOICE_SAMPLE_RATE_HZ,
					durationSec: 0,
					textChars: trimmed.length,
					workerWarm: false,
					streamingMode: "batch_generate",
				};
				return { audio: EMPTY_PCM };
			}

			const probe = probeVibeVoiceReadiness(env);
			if (!probe.ready) {
				throw new Error(
					`vibevoice TTS not ready (${probe.reason}). Use piper. Voice=${voice}`,
				);
			}

			await mkdir(tmpDir, { recursive: true });
			const wavPath = join(tmpDir, `vv-${randomUUID()}.wav`);
			const worker = getClient(probe);
			const wasWarm = worker.warm;
			const t0 = performance.now();

			// wait policy: ensure READY before synth (may take ~14s cold isolated).
			// piper policy is handled by optional bridge — this adapter always waits.
			void onColdStart;

			try {
				if (!worker.warm) {
					await worker.ensureStarted();
				}
				throwIfAborted(signal);

				// The English preset ships in the same code archive; without it the Spanish voice reads the text.
				const englishPt = options.language === "en"
					? resolveVoicePt(probe.home, VIBEVOICE_ENGLISH_VOICE)
					: undefined;
				const voiceField = englishPt ? { voice_pt: englishPt } : {};
				const msg = await worker.request(
					streamPcm
						? { op: "synth", text: trimmed, stream: true, ...voiceField }
						: { op: "synth", text: trimmed, out_wav: wavPath, ...voiceField },
					signal,
					timeoutMs,
					streamPcm ? options.onPcm : undefined,
				);
				throwIfAborted(signal);
				if (streamPcm) {
					const generateSec =
						typeof msg.generate_sec === "number" ? msg.generate_sec : undefined;
					const vramPeak =
						typeof msg.vram_peak_generate_mb === "number"
							? msg.vram_peak_generate_mb
							: undefined;
					const audioSec = typeof msg.audio_sec === "number" ? msg.audio_sec : 0;
					lastMetrics = {
						synthesizeMs: Math.round(performance.now() - t0),
						...(loadMsOnce !== undefined ? { loadMs: loadMsOnce } : {}),
						...(generateSec !== undefined ? { generateSec } : {}),
						...(vramPeak !== undefined ? { vramPeakMb: vramPeak } : {}),
						outputBytes: 0,
						sampleRateHz: VIBEVOICE_SAMPLE_RATE_HZ,
						durationSec: audioSec,
						textChars: trimmed.length,
						workerWarm: wasWarm,
						streamingMode: "incremental_pcm",
						...(worker.timeline ? { timeline: worker.timeline } : {}),
					};
					return { audio: EMPTY_PCM };
				}

				if (loadMsOnce === undefined && worker.timeline?.load_total_sec != null) {
					loadMsOnce = Math.round(worker.timeline.load_total_sec * 1000);
				}

				const bytes = new Uint8Array(await readFile(wavPath));
				if (!isWavBuffer(bytes) || bytes.byteLength < 44) {
					throw new Error("vibevoice_invalid_wav_output");
				}
				const generateSec =
					typeof msg.generate_sec === "number" ? msg.generate_sec : undefined;
				const vramPeak =
					typeof msg.vram_peak_generate_mb === "number"
						? msg.vram_peak_generate_mb
						: undefined;
				const audioSec = typeof msg.audio_sec === "number" ? msg.audio_sec : 0;
				const sampleRateHz =
					typeof msg.sample_rate === "number" ? msg.sample_rate : VIBEVOICE_SAMPLE_RATE_HZ;

				lastMetrics = {
					synthesizeMs: Math.round(performance.now() - t0),
					...(loadMsOnce !== undefined ? { loadMs: loadMsOnce } : {}),
					...(generateSec !== undefined ? { generateSec } : {}),
					...(vramPeak !== undefined ? { vramPeakMb: vramPeak } : {}),
					outputBytes: bytes.byteLength,
					sampleRateHz,
					durationSec: audioSec,
					textChars: trimmed.length,
					workerWarm: wasWarm,
					streamingMode: "batch_generate",
					...(worker.timeline ? { timeline: worker.timeline } : {}),
				};

				return {
					audio: { bytes, sampleRateHz, channels: 1, format: "wav" },
				};
			} catch (e) {
				if (e instanceof AbortError || signal.aborted) {
					// Soft cancel — model stays resident.
					throw e instanceof AbortError ? e : new AbortError();
				}
				// Fatal path: drop worker so next attempt can recover.
				await worker.dispose();
				client = undefined;
				throw e;
			} finally {
				if (!keepTemp) {
					await unlink(wavPath).catch(() => {});
				}
			}
		},
	};

	return adapter;
}

export function vibevoiceEmptyAudioForTests(): AudioChunk {
	return EMPTY_PCM;
}
