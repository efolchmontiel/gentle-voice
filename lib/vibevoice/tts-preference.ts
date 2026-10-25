/**
 * Which TTS engine the user chose.
 * The file lives in the Gentle Voice home. It does not change Gentle Shell profiles.
 *
 * unset — VibeVoice when that engine is ready; otherwise Piper until the user chooses
 * piper — explicit; a ready VibeVoice install is not selected
 * vibevoice — explicit; used only when that engine passes the probe
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveGentleVoiceStorage } from "../runtime/storage.ts";

export const TTS_ENGINE_PREFERENCE_KIND = "gentle-voice.tts-engine" as const;
export type TtsEnginePreference = "unset" | "piper" | "vibevoice";
export type TtsEngineChoice = "piper" | "vibevoice" | "kokoro";

export function ttsEnginePreferencePath(voiceHome: string): string {
	return join(voiceHome, "tts-engine.json");
}

export function resolveVoiceHomeForTts(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.GENTLE_VOICE_HOME?.trim();
	if (home) return home;
	return resolveGentleVoiceStorage({ env }).dataDir;
}

export function readTtsEnginePreference(voiceHome: string): TtsEnginePreference {
	try {
		const raw = JSON.parse(readFileSync(ttsEnginePreferencePath(voiceHome), "utf8")) as {
			kind?: unknown;
			engine?: unknown;
		};
		if (raw.kind !== TTS_ENGINE_PREFERENCE_KIND) return "unset";
		if (raw.engine === "piper" || raw.engine === "vibevoice") return raw.engine;
		return "unset";
	} catch {
		return "unset";
	}
}

export function writeTtsEnginePreference(
	voiceHome: string,
	engine: Exclude<TtsEnginePreference, "unset">,
): void {
	const path = ttsEnginePreferencePath(voiceHome);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({
			kind: TTS_ENGINE_PREFERENCE_KIND,
			engine,
			updatedAt: new Date().toISOString(),
		}, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

export function resolvePreferredTts(env: NodeJS.ProcessEnv = process.env): TtsEngineChoice | undefined {
	const fromEnv = env.GENTLE_VOICE_TTS?.trim().toLowerCase();
	if (fromEnv === "piper" || fromEnv === "vibevoice" || fromEnv === "kokoro") return fromEnv;
	const stored = readTtsEnginePreference(resolveVoiceHomeForTts(env));
	if (stored === "piper" || stored === "vibevoice") return stored;
	return undefined;
}

/**
 * Explicit Piper wins. A ready VibeVoice install is selected when the user
 * has not chosen another engine. A missing install stays on Piper.
 */
export function chooseTtsEngine(input: {
	readonly preference: TtsEngineChoice | undefined;
	readonly vibevoiceReady: boolean;
	readonly kokoroReady: boolean;
}): TtsEngineChoice {
	if (input.preference === "piper") return "piper";
	if (input.preference === "kokoro") return input.kokoroReady ? "kokoro" : "piper";
	if (input.vibevoiceReady && (input.preference === "vibevoice" || input.preference === undefined)) {
		return "vibevoice";
	}
	return "piper";
}

export function readTtsRecommendationDeclined(voiceHome: string): boolean {
	try {
		const raw = JSON.parse(readFileSync(ttsEnginePreferencePath(voiceHome), "utf8")) as {
			kind?: unknown;
			engine?: unknown;
			recommendation?: unknown;
		};
		return raw.kind === TTS_ENGINE_PREFERENCE_KIND
			&& raw.recommendation === "declined"
			&& raw.engine !== "piper"
			&& raw.engine !== "vibevoice";
	} catch {
		return false;
	}
}

export function writeTtsRecommendationDeclined(voiceHome: string): void {
	const path = ttsEnginePreferencePath(voiceHome);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({
			kind: TTS_ENGINE_PREFERENCE_KIND,
			recommendation: "declined",
			updatedAt: new Date().toISOString(),
		}, null, 2)}\n`,
		{ mode: 0o600 },
	);
}
