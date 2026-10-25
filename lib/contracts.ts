/**
 * Public contracts for Gentle Voice adapters and session control.
 * Phase 0: no real audio I/O — implementations may be stubs.
 */

import type { ListenStats } from "./vad/listen-stats.ts";

/** High-level voice interaction mode. */
export type VoiceMode = "dictation" | "conversation" | "silent";

/**
 * Session phase for the voice state machine.
 * Orthogonal to VoiceMode: mute/silent mode can still leave phase idle|listening|…
 */
export type VoicePhase =
	| "idle"
	| "listening"
	| "transcribing"
	| "awaiting_agent"
	| "speaking"
	| "error";

export type VoiceCommandName =
	| "on"
	| "off"
	| "listen"
	| "stop"
	| "mute"
	| "status"
	| "config"
	| "setup"
	| "storage"
	| "send"
	| "draft"
	| "edit"
	| "converse"
	| "purge"
	| "stream"
	| "voice-ai"
	| "add"
	| "barge-in"
	| "tts"
	| "lang"
	| "vibevoice-setup"
	| "";

/** Platform identifiers for capture/playback adapters. */
export type VoicePlatform = "linux" | "win32" | "darwin" | "unsupported";

/** Capability probe result — never throws; degrade closed. */
export type AdapterAvailability =
	| { status: "ready"; detail?: string }
	| { status: "unavailable"; reason: string; detail?: string }
	| { status: "degraded"; reason: string; detail?: string };

/** Lab diagnostics for one capture segment (no full audio / full transcript). */
export interface CaptureSegmentMeta {
	readonly captureId: string;
	/** Energy VAD saw speech above threshold at least once. */
	readonly speechSeen: boolean;
	readonly endReason: "vad" | "stop" | "max" | "unknown";
	readonly durationMs: number;
	/** Peak frame RMS (0–1). */
	readonly peakRms: number;
	/** Mean frame RMS over the segment (0–1). */
	readonly meanRms: number;
	/** Samples above the VAD speech threshold. Absent on older captures. */
	readonly voicedMs?: number;
	/** ms from capture start to first PCM sample (mic truly ready). */
	readonly firstPcmLatencyMs?: number;
	/** ms from capture start to first VAD speechSeen. */
	readonly speechSeenLatencyMs?: number;
}

export interface AudioChunk {
	/** PCM or container bytes; stubs may use empty buffers. */
	readonly bytes: Uint8Array;
	readonly sampleRateHz: number;
	readonly channels: 1 | 2;
	readonly format: "pcm_s16le" | "wav" | "raw";
	/** Optional capture diagnostics (pipewire + VAD). */
	readonly captureMeta?: CaptureSegmentMeta;
}

export interface CaptureSession {
	readonly id: string;
	stop(signal?: AbortSignal): Promise<AudioChunk>;
}

export interface CaptureAdapter {
	readonly id: string;
	availability(): Promise<AdapterAvailability>;
	start(options: {
		signal: AbortSignal;
		sampleRateHz?: number;
		deviceId?: string;
		/**
		 * Live PCM s16le chunks from the same capture process (no second mic open).
		 * Used for visual amplitude only — do not persist these buffers for waves.
		 */
		onPcmChunk?: (pcm: Uint8Array, meta: { channels: number; sampleRateHz: number }) => void;
		/** Delay before VAD may end (echo hold); PCM still buffered. */
		vadArmDelayMs?: number;
		/** While true, VAD must not close the capture (barge monitor before commit). */
		holdVadEnd?: () => boolean;
		onFirstPcm?: (info: { captureId: string; atMs: number }) => void;
		/** First time VAD/energy marks speech in this capture (incremental STT arm). */
		onSpeechSeen?: (info: { captureId: string; atMs: number }) => void;
		/** Throttled by the caller. Levels only — the adapter does not write audio. */
		onListenStats?: (stats: ListenStats) => void;
	}): Promise<CaptureSession>;
}

export interface SttResult {
	readonly text: string;
	readonly language?: string;
	readonly confidence?: number;
}

export interface SttAdapter {
	readonly id: string;
	availability(): Promise<AdapterAvailability>;
	transcribe(audio: AudioChunk, options: { signal: AbortSignal; language?: string }): Promise<SttResult>;
}

export interface TtsResult {
	readonly audio: AudioChunk;
}

export interface TtsAdapter {
	readonly id: string;
	availability(): Promise<AdapterAvailability>;
	synthesize(text: string, options: {
		signal: AbortSignal;
		voiceId?: string;
		/** "es" or "en". Engines without a voice for it keep their own. */
		language?: string;
		/** Lab-only. Float32 mono frames while VibeVoice is still generating. */
		onPcm?: (frame: {
			seq: number;
			pcm: Uint8Array;
			sampleRateHz: number;
			channels: number;
		}) => void | Promise<void>;
	}): Promise<TtsResult>;
}

export interface PlaybackHandle {
	readonly id: string;
	/** Resolves when playback finishes or is aborted. */
	done: Promise<void>;
	stop(): Promise<void>;
}

export interface PlaybackAdapter {
	readonly id: string;
	availability(): Promise<AdapterAvailability>;
	play(audio: AudioChunk, options: { signal: AbortSignal }): Promise<PlaybackHandle>;
}

/** Child-process cancellation contract used by future real adapters. */
export interface CancellableProcess {
	readonly pid: number | undefined;
	kill(signal?: NodeJS.Signals): boolean;
	readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface ProcessSupervisor {
	spawn(command: string, args: readonly string[], options?: {
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
		cwd?: string;
	}): CancellableProcess;
}

/**
 * Minimal Pi surface Gentle Voice needs (duck-typed).
 * Avoids a hard compile-time dependency on host package layouts in phase 0 tests.
 */
export interface VoiceHostApi {
	registerCommand(name: string, options: {
		description?: string;
		handler: (args: string, ctx: VoiceHostCommandContext) => Promise<void>;
	}): void;
	registerShortcut?(shortcut: string, options: {
		description?: string;
		handler: (ctx: VoiceHostContext) => Promise<void> | void;
	}): void;
	on?(event: string, handler: (event: unknown, ctx: VoiceHostContext) => unknown): () => void;
	sendUserMessage?(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

export interface VoiceHostContext {
	readonly mode: "tui" | "rpc" | "json" | "print" | string;
	readonly hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus?(key: string, text: string | undefined): void;
		/**
		 * Pi TUI: string[] (padded full-width) or factory `(ui, theme) => component`
		 * for compact themed leaves. RPC hosts may only accept string[].
		 */
		setWidget?(
			key: string,
			content:
				| string[]
				| undefined
				| ((ui: unknown, theme: {
					fg(color: string, text: string): string;
					bg?(color: string, text: string): string;
					bold?(text: string): string;
				}) => unknown),
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
		/** Pi 1.2 — put text into the core input editor (native edit path). */
		setEditorText?(text: string): void;
		getEditorText?(): string;
		pasteToEditor?(text: string): void;
		/** Raw terminal bytes (Esc detection). Returns unsubscribe. */
		onTerminalInput?(handler: (data: string) => { consume?: boolean; data?: string } | boolean | void): () => void;
	};
	isIdle(): boolean;
	/** Abort the current agent generation (Pi ExtensionContext.abort). */
	abort?(): void;
	/** Pi 1.2 ReadonlySessionManager (duck-typed) — used to recover final assistant text. */
	sessionManager?: {
		getEntries?: () => readonly unknown[];
		getSessionId?: () => string | undefined;
		sessionId?: string;
	};
	/** Pi ModelRegistry — Voice AI auxiliary inference (complete / streamSimple). */
	modelRegistry?: unknown;
	/** Active orchestrator model (never swapped by Voice AI). */
	model?: { provider?: string; id?: string };
	thinkingLevel?: string;
}

export type VoiceHostCommandContext = VoiceHostContext;

/** Structured assistant content used by the final-utterance policy (no second LLM). */
export interface AssistantTextPart {
	readonly type: "text";
	readonly text: string;
}

export interface AssistantToolCallPart {
	readonly type: "toolCall";
	readonly name?: string;
}

export interface AssistantThinkingPart {
	readonly type: "thinking";
	readonly thinking?: string;
}

export type AssistantContentPart =
	| AssistantTextPart
	| AssistantToolCallPart
	| AssistantThinkingPart
	| { readonly type: string };

export interface AssistantMessageLike {
	readonly role?: string;
	readonly content?: readonly AssistantContentPart[];
}

export interface FinalUtteranceInput {
	readonly message: AssistantMessageLike | null | undefined;
	/** Agent activity outcome when known. */
	readonly outcome?: "completed" | "aborted" | "error";
	readonly maxSentences?: number;
	readonly maxChars?: number;
}

export interface FinalUtteranceResult {
	readonly speak: boolean;
	readonly text: string;
	readonly reason: string;
}
