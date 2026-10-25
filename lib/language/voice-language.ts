/**
 * Which language Gentle Voice listens and speaks in.
 * The file lives in the Gentle Voice home, next to tts-engine.json.
 *
 * auto — Whisper detects Spanish or English; the reply follows the last turn
 * es   — always Spanish
 * en   — always English
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const VOICE_LANGUAGE_KIND = "gentle-voice.language" as const;
export type VoiceLanguageMode = "auto" | "es" | "en";
export type SpokenLanguage = "es" | "en";

export const DEFAULT_SPOKEN_LANGUAGE: SpokenLanguage = "es";

export function parseVoiceLanguageMode(value: unknown): VoiceLanguageMode | undefined {
	const v = typeof value === "string" ? value.trim().toLowerCase() : "";
	return v === "auto" || v === "es" || v === "en" ? v : undefined;
}

/** Whisper codes such as "es", "en", "english" or "spanish"; anything else is unknown. */
export function toSpokenLanguage(code: string | undefined): SpokenLanguage | undefined {
	const c = code?.trim().toLowerCase() ?? "";
	if (c === "es" || c.startsWith("es-") || c === "spanish") return "es";
	if (c === "en" || c.startsWith("en-") || c === "english") return "en";
	return undefined;
}

export function voiceLanguagePath(voiceHome: string): string {
	return join(voiceHome, "language.json");
}

export function readVoiceLanguageMode(voiceHome: string): VoiceLanguageMode {
	try {
		const raw = JSON.parse(readFileSync(voiceLanguagePath(voiceHome), "utf8")) as {
			kind?: unknown;
			mode?: unknown;
		};
		if (raw.kind !== VOICE_LANGUAGE_KIND) return "auto";
		return parseVoiceLanguageMode(raw.mode) ?? "auto";
	} catch {
		return "auto";
	}
}

export function writeVoiceLanguageMode(voiceHome: string, mode: VoiceLanguageMode): void {
	const path = voiceLanguagePath(voiceHome);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({ kind: VOICE_LANGUAGE_KIND, mode, updatedAt: new Date().toISOString() }, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

/** GENTLE_VOICE_LANG wins over the stored file. */
export function resolveVoiceLanguageMode(voiceHome: string, env: NodeJS.ProcessEnv = process.env): VoiceLanguageMode {
	return parseVoiceLanguageMode(env.GENTLE_VOICE_LANG) ?? readVoiceLanguageMode(voiceHome);
}

/** Language passed to Whisper: "auto" lets it detect, otherwise the fixed one. */
export function sttLanguageFor(mode: VoiceLanguageMode): string {
	return mode;
}

/** Language the reply is spoken in. Auto follows the last detected turn. */
export function spokenLanguageFor(mode: VoiceLanguageMode, lastTurn: SpokenLanguage | undefined): SpokenLanguage {
	if (mode !== "auto") return mode;
	return lastTurn ?? DEFAULT_SPOKEN_LANGUAGE;
}

export function describeVoiceLanguage(mode: VoiceLanguageMode, lastTurn: SpokenLanguage | undefined): string {
	const name = (l: SpokenLanguage) => (l === "en" ? "English" : "Spanish");
	if (mode === "auto") {
		return `auto (Spanish or English, detected per turn; replying in ${name(spokenLanguageFor(mode, lastTurn))})`;
	}
	return name(mode);
}
