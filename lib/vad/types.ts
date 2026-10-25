/**
 * Shared VAD contract for PipeWire capture.
 * Energy and Silero both implement this so the capture adapter stays backend-agnostic.
 */

export type VadPhase = "leading_silence" | "speech" | "pause" | "ended";

export type VadBackendId = "energy" | "silero";

export interface VadEngineState {
	readonly phase: VadPhase;
	readonly speechSeen: boolean;
	readonly elapsedMs: number;
	readonly silenceMs: number;
	/** Milliseconds of samples actually above the speech threshold. */
	readonly voicedMs?: number;
	/** Backend that produced this state (for chrome / metrics). */
	readonly backend: VadBackendId;
	/** Last speech probability when Silero; undefined for energy. */
	readonly speechProb?: number;
}

export interface VadEngine {
	readonly backend: VadBackendId;
	readonly state: VadEngineState;
	/** Feed interleaved s16le mono PCM. Returns true when utterance should end. */
	pushPcmS16le(chunk: Uint8Array): boolean;
	reset(): void;
	/**
	 * Async engines update speech and end after push returns.
	 * Capture uses this so the turn can close without waiting for another chunk.
	 */
	setUpdateListener?(listener: (() => void) | undefined): void;
	/** Last inference error. Empty when the model is scoring frames. */
	readonly inferenceError?: string;
	/** Optional async dispose. */
	dispose?(): void | Promise<void>;
}

export interface VadTimingOptions {
	/** Silence hang after speech before end (ms). */
	readonly silenceHangMs?: number;
	/** Brief pause inside utterance that must NOT end capture (ms). */
	readonly maxIntraPauseMs?: number;
	/** Extra audio after hang before ending (ms). */
	readonly postRollMs?: number;
	/** Hard cap on total capture (ms). */
	readonly maxListenMs?: number;
	readonly sampleRateHz?: number;
}
