/**
 * Silero VAD (ONNX) — speech probability over 32 ms frames @ 16 kHz.
 * Model: snakers4/silero-vad (MIT). Runtime: sherpa-onnx (Apache-2.0), see sherpa-runtime.ts.
 * Never throws into the capture path: callers use resolveVad / tryCreateSileroVad.
 *
 * Injected scorers may be async. `pushPcmS16le` returns the current ended
 * flag; with an async scorer end may latch one chunk later.
 */

import { access, constants } from "node:fs/promises";
import { loadSherpa, resolveSherpaRuntime } from "./sherpa-runtime.ts";
import type { VadEngine, VadEngineState, VadPhase, VadTimingOptions } from "./types.ts";

/** 16 kHz Silero window (official). */
export const SILERO_WINDOW_SAMPLES = 512;

export interface SileroVadOptions extends VadTimingOptions {
	/** Path to silero_vad.onnx (required for real inference). */
	readonly modelPath: string;
	/** Speech probability threshold (0–1). Default 0.5. */
	readonly speechProbThreshold?: number;
	/** Env used to find the sherpa runtime and storage. Defaults to process.env. */
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * Injected frame runner (tests). Returns speech probability in [0, 1].
	 * Sync or async.
	 */
	readonly runFrame?: (frame: Float32Array) => number | Promise<number>;
}

export type SileroLoadResult =
	| { readonly ok: true; readonly engine: VadEngine }
	| { readonly ok: false; readonly reason: string };

function pcmChunkToFloat32(chunk: Uint8Array): Float32Array {
	const samples = Math.floor(chunk.byteLength / 2);
	const out = new Float32Array(samples);
	const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	for (let i = 0; i < samples; i++) {
		out[i] = view.getInt16(i * 2, true) / 32768;
	}
	return out;
}

/**
 * Create Silero VAD from a frame scorer (sync or async).
 */
export function createSileroVadFromRunner(
	options: Omit<SileroVadOptions, "modelPath"> & {
		runFrame: (frame: Float32Array) => number | Promise<number>;
		modelPath?: string;
	},
): VadEngine {
	const silenceHangMs = options.silenceHangMs ?? 900;
	const maxIntraPauseMs = options.maxIntraPauseMs ?? 350;
	const postRollMs = options.postRollMs ?? 150;
	const maxListenMs = options.maxListenMs ?? 60_000;
	const sampleRateHz = options.sampleRateHz ?? 16_000;
	const speechProbThreshold = options.speechProbThreshold ?? 0.5;
	const runFrame = options.runFrame;

	let phase: VadPhase = "leading_silence";
	let speechSeen = false;
	let elapsedSamples = 0;
	let silenceSamples = 0;
	let postRollSamples = 0;
	let voicedSamples = 0;
	let lastProb = 0;
	let pending = new Float32Array(0);
	let ended = false;
	let draining = false;
	let listener: (() => void) | undefined;
	let inferenceError = "";

	const samplesToMs = (n: number) => (n / sampleRateHz) * 1_000;

	const applyProb = (prob: number, frameSamples: number): void => {
		lastProb = prob;
		elapsedSamples += frameSamples;
		const elapsedMs = samplesToMs(elapsedSamples);
		if (elapsedMs >= maxListenMs) {
			phase = "ended";
			ended = true;
			return;
		}
		const speaking = prob >= speechProbThreshold;
		if (speaking) {
			speechSeen = true;
			voicedSamples += frameSamples;
			silenceSamples = 0;
			postRollSamples = 0;
			phase = "speech";
			return;
		}
		silenceSamples += frameSamples;
		const silenceMs = samplesToMs(silenceSamples);
		if (!speechSeen) {
			phase = "leading_silence";
			return;
		}
		if (silenceMs < maxIntraPauseMs) {
			phase = "pause";
			return;
		}
		if (silenceMs >= silenceHangMs) {
			postRollSamples += frameSamples;
			if (samplesToMs(postRollSamples) >= postRollMs) {
				phase = "ended";
				ended = true;
				return;
			}
			phase = "pause";
			return;
		}
		phase = "pause";
	};

	const notify = (): void => {
		try {
			listener?.();
		} catch {
			/* the capture owner handles its own errors */
		}
	};

	const drain = async (): Promise<void> => {
		if (draining) return;
		draining = true;
		try {
			while (pending.length >= SILERO_WINDOW_SAMPLES && !ended) {
				const frame = pending.slice(0, SILERO_WINDOW_SAMPLES);
				pending = pending.slice(SILERO_WINDOW_SAMPLES);
				const scored = runFrame(frame);
				const prob = typeof scored === "number" ? scored : await scored;
				applyProb(prob, SILERO_WINDOW_SAMPLES);
				notify();
			}
		} catch (error) {
			inferenceError = error instanceof Error ? error.message.slice(0, 160) : "silero_inference_failed";
			notify();
		} finally {
			draining = false;
			if (!inferenceError && pending.length >= SILERO_WINDOW_SAMPLES && !ended) {
				void drain();
			}
		}
	};

	return {
		backend: "silero",
		get inferenceError(): string {
			return inferenceError;
		},
		setUpdateListener(next: (() => void) | undefined): void {
			listener = next;
		},
		get state(): VadEngineState {
			return {
				phase,
				speechSeen,
				elapsedMs: samplesToMs(elapsedSamples),
				silenceMs: samplesToMs(silenceSamples),
				voicedMs: samplesToMs(voicedSamples),
				backend: "silero",
				speechProb: lastProb,
			};
		},
		pushPcmS16le(chunk: Uint8Array): boolean {
			if (ended) return true;
			const f32 = pcmChunkToFloat32(chunk);
			const merged = new Float32Array(pending.length + f32.length);
			merged.set(pending);
			merged.set(f32, pending.length);
			pending = merged;
			// One consumer. A sync scorer finishes before this returns.
			// An async scorer latches speech and end on setUpdateListener.
			void drain();
			return ended;
		},
		reset(): void {
			phase = "leading_silence";
			speechSeen = false;
			elapsedSamples = 0;
			silenceSamples = 0;
			postRollSamples = 0;
			voicedSamples = 0;
			lastProb = 0;
			pending = new Float32Array(0);
			ended = false;
			draining = false;
			inferenceError = "";
		},
	};
}

/**
 * Load Silero through the sherpa-onnx runtime. Fail-soft reasons for resolveVad.
 * sherpa reports speech per 512-sample window (not a probability), so the
 * window score is 1 or 0 and the pause/end timing above stays ours.
 */
export async function tryCreateSileroVad(options: SileroVadOptions): Promise<SileroLoadResult> {
	if (options.runFrame) {
		return {
			ok: true,
			engine: createSileroVadFromRunner({ ...options, runFrame: options.runFrame }),
		};
	}
	const modelPath = options.modelPath?.trim();
	if (!modelPath) {
		return { ok: false, reason: "silero_model_path_missing" };
	}
	try {
		await access(modelPath, constants.R_OK);
	} catch {
		return { ok: false, reason: "silero_model_unreadable" };
	}
	if ((options.sampleRateHz ?? 16_000) !== 16_000) {
		return { ok: false, reason: "silero_requires_16khz" };
	}

	const runtime = resolveSherpaRuntime(options.env);
	if (!runtime) {
		return { ok: false, reason: "sherpa_runtime_missing" };
	}

	try {
		const sherpa = loadSherpa(runtime);
		const config = {
			sileroVad: {
				model: modelPath,
				threshold: options.speechProbThreshold ?? 0.5,
				// Our state machine owns pauses and end of turn; keep sherpa's own hangover minimal.
				minSilenceDuration: 0.1,
				minSpeechDuration: 0.05,
				maxSpeechDuration: 60,
				windowSize: SILERO_WINDOW_SAMPLES,
			},
			sampleRate: 16_000,
			numThreads: 1,
			provider: "cpu",
			debug: 0,
		};
		let vad = new sherpa.Vad(config, 30);
		const runFrame = (frame: Float32Array): number => {
			if (frame.length !== SILERO_WINDOW_SAMPLES) {
				throw new Error(`silero frame must be ${SILERO_WINDOW_SAMPLES} samples`);
			}
			vad.acceptWaveform(frame);
			const detected = vad.isDetected();
			// Finished segments are not used; drop them so the buffer stays bounded.
			while (!vad.isEmpty()) vad.pop();
			return detected ? 1 : 0;
		};

		const engine = createSileroVadFromRunner({ ...options, runFrame });
		const baseReset = engine.reset.bind(engine);
		engine.reset = () => {
			vad = new sherpa.Vad(config, 30);
			baseReset();
		};
		return { ok: true, engine };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `silero_session_failed:${message.slice(0, 120)}` };
	}
}
