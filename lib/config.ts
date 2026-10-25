/**
 * Validatable configuration for Gentle Voice.
 * Defaults never embed developer-specific absolute paths.
 * Paths resolve from env overrides, then optional config home, then unset (degraded).
 */

import { join } from "node:path";
import type { VoiceMode, VoicePlatform } from "./contracts.ts";
import { resolveRuntimeLayout } from "./runtime/paths.ts";
import type { SpeechRenderMode } from "./tts/speech-renderer.ts";

export const VOICE_CONFIG_SCHEMA = "gentle-voice.config/v1" as const;

export interface VoicePathsConfig {
	/** Root for voice state/logs when set; otherwise unset. */
	home?: string;
	/** Directory containing STT/TTS model files. */
	models?: string;
	/** Writable cache directory. */
	cache?: string;
	/** Scratch / temp directory. */
	tmp?: string;
}

export interface VoiceEnginesConfig {
	/** Logical STT engine id (e.g. whisper-cpp). Empty = auto/stub. */
	stt: string;
	/** Logical TTS engine id (e.g. piper). Empty = auto/stub. */
	tts: string;
	/** Preferred capture backend id. Empty = auto. */
	capture: string;
	/** Preferred playback backend id. Empty = auto. */
	playback: string;
	/** Relative or absolute STT model path under models/, or absolute override. */
	sttModel?: string;
	/** Relative or absolute TTS voice model path under models/, or absolute override. */
	ttsVoice?: string;
	/** BCP-47 / whisper language hint. */
	language: string;
}

export interface VoiceBehaviorConfig {
	mode: VoiceMode;
	/** When true, never play TTS (STT may still run). */
	muted: boolean;
	/** Optional keybinding string for Pi registerShortcut; unset = no shortcut. */
	shortcut?: string;
	/** Silence hang time before ending a listen window (ms). */
	silenceMs: number;
	/** Hard cap on a single listen capture (ms). */
	maxListenMs: number;
	/** Max sentences kept for spoken replies. */
	maxSpokenSentences: number;
	/** Soft char budget after sentence selection (not a blind prefix cut of the raw reply). */
	maxSpokenChars: number;
	/** Speak warnings/errors even when muted is false and outcome is error. */
	speakWarnings: boolean;
	/**
	 * When false (Phase 2A default), show transcript for review and do not
	 * call sendUserMessage / LLM. When true, prior auto-submit behavior.
	 */
	autoSubmitTranscript: boolean;
	/**
	 * Lab fluent conversation (opt-in): VAD end → optional auto-send → speak → listen.
	 * Must stay false outside lab authorization.
	 */
	fluentConversation: boolean;
	/** RMS speech threshold for energy VAD (0–1). */
	vadSpeechThreshold: number;
	/** Max intra-utterance pause that does not end capture (ms). */
	vadMaxIntraPauseMs: number;
	/**
	 * VAD backend: energy | silero | auto (try Silero, fall back to energy).
	 * Default auto — without the Silero model or runtime, identical to energy.
	 */
	vadBackend: "energy" | "silero" | "auto";
	/** Optional path to silero_vad.onnx (else GENTLE_VOICE_SILERO_VAD). */
	sileroModelPath?: string;
	/**
	 * Phase 3.6 inc-2: provisional Whisper while listening (UI only).
	 * Final submit still waits for VAD end + full STT. Env GENTLE_VOICE_INCREMENTAL_STT overrides.
	 */
	incrementalStt: boolean;
	/**
	 * Phase 2D: show real-PCM Unicode wave bars in the aboveEditor widget.
	 * When false, chrome stays single-line (no animation / no meter paint).
	 */
	visualWaves: boolean;
	/** Cap widget repaint rate (4–15). Default 12. */
	visualFps: number;
	/**
	 * ms to wait after TTS playback before re-opening the mic (echo guard).
	 * Lab fluent conversation only.
	 */
	echoSettleMs: number;
	/**
	 * How agent text is transformed for TTS only (never mutates written reply).
	 * natural | detailed | verbatim
	 */
	speechMode: SpeechRenderMode;
}

/**
 * Voice AI — optional second LLM turn for conversational narration.
 * Model/effort come from GS `/gentle:profiles` role (default `voice-ai`), not duplicated here.
 */
export interface VoiceAiConfig {
	/** Master switch. Lab may enable via GENTLE_VOICE_AI=1. */
	enabled: boolean;
	/** Profile routing role name (not a top-level profile). */
	role: string;
	/** When role is absent: use profile orchestrator / active model for narration. */
	fallback: "orchestrator";
	/** When role invalid or API fails: Speech Renderer only. */
	onError: "deterministic";
	style: "natural";
	/**
	 * after_settle — wait for orchestrator final text, narrate, then stream TTS.
	 * off — never call narrator LLM (deterministic stream of orchestrator text).
	 */
	streaming: "after_settle" | "off";
	timeoutMs: number;
	maxInputChars: number;
}

export interface VoiceConfig {
	schema: typeof VOICE_CONFIG_SCHEMA;
	enabled: boolean;
	paths: VoicePathsConfig;
	engines: VoiceEnginesConfig;
	behavior: VoiceBehaviorConfig;
	voiceAi: VoiceAiConfig;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = Object.freeze({
	schema: VOICE_CONFIG_SCHEMA,
	enabled: false,
	paths: Object.freeze({}),
	engines: Object.freeze({
		stt: "",
		tts: "",
		capture: "",
		playback: "",
		language: "auto",
	}),
	behavior: Object.freeze({
		mode: "conversation" as VoiceMode,
		muted: false,
		silenceMs: 1200,
		maxListenMs: 60_000,
		maxSpokenSentences: 3,
		maxSpokenChars: 480,
		speakWarnings: true,
		autoSubmitTranscript: false,
		fluentConversation: false,
		/** Slightly more sensitive for quiet close-mic speech (phase 3.6). */
		vadSpeechThreshold: 0.009,
		vadMaxIntraPauseMs: 450,
		vadBackend: "auto" as const,
		/** Off by default in product; GS-Lab enables via env. */
		incrementalStt: false,
		visualWaves: true,
		visualFps: 12,
		echoSettleMs: 350,
		speechMode: "natural" as SpeechRenderMode,
	}),
	voiceAi: Object.freeze({
		enabled: false,
		role: "voice-ai",
		fallback: "orchestrator" as const,
		onError: "deterministic" as const,
		style: "natural" as const,
		streaming: "after_settle" as const,
		timeoutMs: 25_000,
		maxInputChars: 8_000,
	}),
});

/**
 * Process lock for Voice AI. Unset leaves the config as-is so the preference
 * file and conversational mode can still decide. Does not write profiles.
 */
export function applyVoiceAiEnvOverrides(
	config: VoiceConfig,
	env: NodeJS.ProcessEnv = process.env,
): VoiceConfig {
	const flag = env.GENTLE_VOICE_AI?.trim().toLowerCase();
	if (flag === "1" || flag === "true" || flag === "on") {
		return { ...config, voiceAi: { ...config.voiceAi, enabled: true } };
	}
	if (flag === "0" || flag === "false" || flag === "off") {
		return { ...config, voiceAi: { ...config.voiceAi, enabled: false } };
	}
	return config;
}

export type VoiceConfigValidation =
	| { ok: true; config: VoiceConfig }
	| { ok: false; errors: string[] };

const MODES: ReadonlySet<string> = new Set(["dictation", "conversation", "silent"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string, errors: string[]): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		errors.push(`${field} must be a string`);
		return undefined;
	}
	return value;
}

function requiredInt(value: unknown, field: string, min: number, max: number, errors: string[], fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		errors.push(`${field} must be an integer in [${min}, ${max}]`);
		return fallback;
	}
	return value;
}

/**
 * Validate and normalize unknown JSON into VoiceConfig.
 * Fail closed: malformed input yields ok:false and never partial-enables audio.
 */
export function validateVoiceConfig(input: unknown): VoiceConfigValidation {
	const errors: string[] = [];
	if (!isPlainObject(input)) {
		return { ok: false, errors: ["config root must be an object"] };
	}
	if (input.schema !== VOICE_CONFIG_SCHEMA) {
		errors.push(`schema must be "${VOICE_CONFIG_SCHEMA}"`);
	}
	if (typeof input.enabled !== "boolean") {
		errors.push("enabled must be a boolean");
	}

	const pathsIn = isPlainObject(input.paths) ? input.paths : {};
	if (input.paths !== undefined && !isPlainObject(input.paths)) {
		errors.push("paths must be an object");
	}
	const enginesIn = isPlainObject(input.engines) ? input.engines : {};
	if (input.engines !== undefined && !isPlainObject(input.engines)) {
		errors.push("engines must be an object");
	}
	const behaviorIn = isPlainObject(input.behavior) ? input.behavior : {};
	if (input.behavior !== undefined && !isPlainObject(input.behavior)) {
		errors.push("behavior must be an object");
	}
	const voiceAiIn = isPlainObject(input.voiceAi) ? input.voiceAi : {};
	if (input.voiceAi !== undefined && !isPlainObject(input.voiceAi)) {
		errors.push("voiceAi must be an object");
	}

	const mode = behaviorIn.mode === undefined
		? DEFAULT_VOICE_CONFIG.behavior.mode
		: typeof behaviorIn.mode === "string" && MODES.has(behaviorIn.mode)
			? behaviorIn.mode as VoiceMode
			: (errors.push('behavior.mode must be "dictation" | "conversation" | "silent"'), DEFAULT_VOICE_CONFIG.behavior.mode);

	const muted = behaviorIn.muted === undefined
		? DEFAULT_VOICE_CONFIG.behavior.muted
		: typeof behaviorIn.muted === "boolean"
			? behaviorIn.muted
			: (errors.push("behavior.muted must be a boolean"), DEFAULT_VOICE_CONFIG.behavior.muted);

	const speakWarnings = behaviorIn.speakWarnings === undefined
		? DEFAULT_VOICE_CONFIG.behavior.speakWarnings
		: typeof behaviorIn.speakWarnings === "boolean"
			? behaviorIn.speakWarnings
			: (errors.push("behavior.speakWarnings must be a boolean"), DEFAULT_VOICE_CONFIG.behavior.speakWarnings);

	const autoSubmitTranscript = behaviorIn.autoSubmitTranscript === undefined
		? DEFAULT_VOICE_CONFIG.behavior.autoSubmitTranscript
		: typeof behaviorIn.autoSubmitTranscript === "boolean"
			? behaviorIn.autoSubmitTranscript
			: (errors.push("behavior.autoSubmitTranscript must be a boolean"), DEFAULT_VOICE_CONFIG.behavior.autoSubmitTranscript);

	const fluentConversation = behaviorIn.fluentConversation === undefined
		? DEFAULT_VOICE_CONFIG.behavior.fluentConversation
		: typeof behaviorIn.fluentConversation === "boolean"
			? behaviorIn.fluentConversation
			: (errors.push("behavior.fluentConversation must be a boolean"), DEFAULT_VOICE_CONFIG.behavior.fluentConversation);

	const shortcut = optionalString(behaviorIn.shortcut, "behavior.shortcut", errors);
	if (shortcut === "") {
		errors.push("behavior.shortcut must be non-empty when set (omit the key for no shortcut)");
	}

	const config: VoiceConfig = {
		schema: VOICE_CONFIG_SCHEMA,
		enabled: typeof input.enabled === "boolean" ? input.enabled : false,
		paths: {
			home: optionalString(pathsIn.home, "paths.home", errors),
			models: optionalString(pathsIn.models, "paths.models", errors),
			cache: optionalString(pathsIn.cache, "paths.cache", errors),
			tmp: optionalString(pathsIn.tmp, "paths.tmp", errors),
		},
		engines: {
			stt: optionalString(enginesIn.stt, "engines.stt", errors) ?? "",
			tts: optionalString(enginesIn.tts, "engines.tts", errors) ?? "",
			capture: optionalString(enginesIn.capture, "engines.capture", errors) ?? "",
			playback: optionalString(enginesIn.playback, "engines.playback", errors) ?? "",
			sttModel: optionalString(enginesIn.sttModel, "engines.sttModel", errors),
			ttsVoice: optionalString(enginesIn.ttsVoice, "engines.ttsVoice", errors),
			language: optionalString(enginesIn.language, "engines.language", errors) ?? DEFAULT_VOICE_CONFIG.engines.language,
		},
		behavior: {
			mode,
			muted,
			...(shortcut ? { shortcut } : {}),
			silenceMs: requiredInt(behaviorIn.silenceMs, "behavior.silenceMs", 0, 30_000, errors, DEFAULT_VOICE_CONFIG.behavior.silenceMs),
			maxListenMs: requiredInt(behaviorIn.maxListenMs, "behavior.maxListenMs", 1000, 600_000, errors, DEFAULT_VOICE_CONFIG.behavior.maxListenMs),
			maxSpokenSentences: requiredInt(behaviorIn.maxSpokenSentences, "behavior.maxSpokenSentences", 1, 12, errors, DEFAULT_VOICE_CONFIG.behavior.maxSpokenSentences),
			maxSpokenChars: requiredInt(behaviorIn.maxSpokenChars, "behavior.maxSpokenChars", 40, 4000, errors, DEFAULT_VOICE_CONFIG.behavior.maxSpokenChars),
			speakWarnings,
			autoSubmitTranscript,
			fluentConversation,
			vadSpeechThreshold: typeof behaviorIn.vadSpeechThreshold === "number"
				? behaviorIn.vadSpeechThreshold
				: DEFAULT_VOICE_CONFIG.behavior.vadSpeechThreshold,
			vadMaxIntraPauseMs: requiredInt(
				behaviorIn.vadMaxIntraPauseMs,
				"behavior.vadMaxIntraPauseMs",
				50,
				5_000,
				errors,
				DEFAULT_VOICE_CONFIG.behavior.vadMaxIntraPauseMs,
			),
			vadBackend: ((): "energy" | "silero" | "auto" => {
				const v = behaviorIn.vadBackend;
				if (v === undefined) return DEFAULT_VOICE_CONFIG.behavior.vadBackend;
				if (v === "energy" || v === "silero" || v === "auto") return v;
				errors.push("behavior.vadBackend must be energy|silero|auto");
				return DEFAULT_VOICE_CONFIG.behavior.vadBackend;
			})(),
			...(typeof behaviorIn.sileroModelPath === "string" && behaviorIn.sileroModelPath.trim()
				? { sileroModelPath: behaviorIn.sileroModelPath.trim() }
				: {}),
			incrementalStt: behaviorIn.incrementalStt === undefined
				? DEFAULT_VOICE_CONFIG.behavior.incrementalStt
				: typeof behaviorIn.incrementalStt === "boolean"
					? behaviorIn.incrementalStt
					: (errors.push("behavior.incrementalStt must be a boolean"), DEFAULT_VOICE_CONFIG.behavior.incrementalStt),
			visualWaves: behaviorIn.visualWaves === undefined
				? DEFAULT_VOICE_CONFIG.behavior.visualWaves
				: typeof behaviorIn.visualWaves === "boolean"
					? behaviorIn.visualWaves
					: (errors.push("behavior.visualWaves must be a boolean"), DEFAULT_VOICE_CONFIG.behavior.visualWaves),
			visualFps: requiredInt(
				behaviorIn.visualFps,
				"behavior.visualFps",
				4,
				15,
				errors,
				DEFAULT_VOICE_CONFIG.behavior.visualFps,
			),
			echoSettleMs: requiredInt(
				behaviorIn.echoSettleMs,
				"behavior.echoSettleMs",
				0,
				3_000,
				errors,
				DEFAULT_VOICE_CONFIG.behavior.echoSettleMs,
			),
			speechMode: ((): SpeechRenderMode => {
				const v = behaviorIn.speechMode;
				if (v === undefined) return DEFAULT_VOICE_CONFIG.behavior.speechMode;
				if (v === "natural" || v === "detailed" || v === "verbatim") return v;
				errors.push("behavior.speechMode must be natural|detailed|verbatim");
				return DEFAULT_VOICE_CONFIG.behavior.speechMode;
			})(),
		},
		voiceAi: {
			enabled: voiceAiIn.enabled === undefined
				? DEFAULT_VOICE_CONFIG.voiceAi.enabled
				: typeof voiceAiIn.enabled === "boolean"
					? voiceAiIn.enabled
					: (errors.push("voiceAi.enabled must be a boolean"), DEFAULT_VOICE_CONFIG.voiceAi.enabled),
			role: ((): string => {
				const v = optionalString(voiceAiIn.role, "voiceAi.role", errors);
				if (v === undefined) return DEFAULT_VOICE_CONFIG.voiceAi.role;
				if (!v.trim()) {
					errors.push("voiceAi.role must be non-empty when set");
					return DEFAULT_VOICE_CONFIG.voiceAi.role;
				}
				return v.trim();
			})(),
			fallback: "orchestrator",
			onError: "deterministic",
			style: "natural",
			streaming: ((): "after_settle" | "off" => {
				const v = voiceAiIn.streaming;
				if (v === undefined) return DEFAULT_VOICE_CONFIG.voiceAi.streaming;
				if (v === "after_settle" || v === "off") return v;
				errors.push('voiceAi.streaming must be "after_settle" | "off"');
				return DEFAULT_VOICE_CONFIG.voiceAi.streaming;
			})(),
			timeoutMs: requiredInt(
				voiceAiIn.timeoutMs,
				"voiceAi.timeoutMs",
				1_000,
				120_000,
				errors,
				DEFAULT_VOICE_CONFIG.voiceAi.timeoutMs,
			),
			maxInputChars: requiredInt(
				voiceAiIn.maxInputChars,
				"voiceAi.maxInputChars",
				200,
				50_000,
				errors,
				DEFAULT_VOICE_CONFIG.voiceAi.maxInputChars,
			),
		},
	};

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, config };
}

/** Environment keys for portable path overrides (never hard-coded user homes). */
export const VOICE_ENV = Object.freeze({
	home: "GENTLE_VOICE_HOME",
	models: "GENTLE_VOICE_MODELS",
	cache: "GENTLE_VOICE_CACHE",
	tmp: "GENTLE_VOICE_TMP",
	config: "GENTLE_VOICE_CONFIG",
});

export interface ResolvedVoicePaths {
	home?: string;
	models?: string;
	cache?: string;
	tmp?: string;
	configFile?: string;
}

/**
 * Resolve path overrides from env, then config.paths, then host-aware runtime layout
 * (GS prefix when isolated/bundled; else XDG / LocalAppData / Application Support).
 * Never uses developer lab absolute paths.
 */
export function resolveVoicePaths(
	config: VoiceConfig,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedVoicePaths {
	const layout = resolveRuntimeLayout(env, detectVoicePlatform());
	const pick = (envKey: string, fromConfig: string | undefined, fallback: string): string => {
		const fromEnv = env[envKey]?.trim();
		if (fromEnv) return fromEnv;
		const cfg = fromConfig?.trim();
		if (cfg && !cfg.includes("${")) return cfg;
		return fallback;
	};
	const home = pick(VOICE_ENV.home, config.paths.home, layout.home);
	const models = pick(VOICE_ENV.models, config.paths.models, layout.modelsDir);
	const cache = pick(VOICE_ENV.cache, config.paths.cache, layout.cacheDir);
	const tmp = pick(VOICE_ENV.tmp, config.paths.tmp, layout.tmpDir);
	const configFile = env[VOICE_ENV.config]?.trim() || layout.configFile;
	return { home, models, cache, tmp, configFile };
}

export function detectVoicePlatform(platform: NodeJS.Platform = process.platform): VoicePlatform {
	if (platform === "linux") return "linux";
	if (platform === "win32") return "win32";
	if (platform === "darwin") return "darwin";
	return "unsupported";
}

/** Example config document for docs and lab (no machine-specific paths). */
export function exampleVoiceConfig(): VoiceConfig {
	return {
		...DEFAULT_VOICE_CONFIG,
		enabled: false,
		paths: {
			home: "${GENTLE_VOICE_HOME}",
			models: "${GENTLE_VOICE_MODELS}",
			cache: "${GENTLE_VOICE_CACHE}",
			tmp: "${GENTLE_VOICE_TMP}",
		},
		engines: {
			...DEFAULT_VOICE_CONFIG.engines,
			stt: "whisper-cpp",
			tts: "piper",
			capture: "auto",
			playback: "auto",
			sttModel: "whisper/ggml-base.bin",
			ttsVoice: "piper/en_US-lessac-medium.onnx",
			language: "auto",
		},
	};
}
