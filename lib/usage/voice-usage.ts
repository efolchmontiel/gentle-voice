/**
 * What the user wants Gentle Voice for. The file lives in the Gentle Voice home,
 * next to tts-engine.json and language.json.
 *
 * conversation — speak, the agent answers out loud, and the microphone opens again
 * dictation    — speak and the text lands in the editor; nothing is read aloud
 * listen       — type as usual; replies are read aloud and the microphone never opens
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VoiceMode } from "../contracts.ts";

export const VOICE_USAGE_KIND = "gentle-voice.usage" as const;
export type VoiceUsage = "conversation" | "dictation" | "listen";

export const USAGE_CONVERSATION_LABEL = "Conversation  (talk and hear the replies)";
export const USAGE_DICTATION_LABEL = "Dictation only  (speech to text, nothing is read aloud)";
export const USAGE_LISTEN_LABEL = "Listen only  (replies read aloud, the microphone stays off)";

export function parseVoiceUsage(value: unknown): VoiceUsage | undefined {
	const v = typeof value === "string" ? value.trim().toLowerCase() : "";
	return v === "conversation" || v === "dictation" || v === "listen" ? v : undefined;
}

export function voiceUsagePath(voiceHome: string): string {
	return join(voiceHome, "usage.json");
}

export function hasStoredVoiceUsage(voiceHome: string): boolean {
	return existsSync(voiceUsagePath(voiceHome));
}

export function readVoiceUsage(voiceHome: string): VoiceUsage {
	try {
		const raw = JSON.parse(readFileSync(voiceUsagePath(voiceHome), "utf8")) as { kind?: unknown; usage?: unknown };
		if (raw.kind !== VOICE_USAGE_KIND) return "conversation";
		return parseVoiceUsage(raw.usage) ?? "conversation";
	} catch {
		return "conversation";
	}
}

export function writeVoiceUsage(voiceHome: string, usage: VoiceUsage): void {
	const path = voiceUsagePath(voiceHome);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({ kind: VOICE_USAGE_KIND, usage, updatedAt: new Date().toISOString() }, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

/** GENTLE_VOICE_USAGE wins over the stored file. */
export function resolveVoiceUsage(voiceHome: string, env: NodeJS.ProcessEnv = process.env): VoiceUsage {
	return parseVoiceUsage(env.GENTLE_VOICE_USAGE) ?? readVoiceUsage(voiceHome);
}

export function voiceModeForUsage(usage: VoiceUsage): VoiceMode {
	return usage;
}

/** Whisper is only skipped when the microphone never opens. */
export function usageNeedsSpeechRecognition(usage: VoiceUsage): boolean {
	return usage !== "listen";
}

/** A voice engine is only skipped when nothing is read aloud. */
export function usageNeedsVoiceEngine(usage: VoiceUsage): boolean {
	return usage !== "dictation";
}

/** Silero ends turns hands-free; dictation is ended by a pause or the shortcut. */
export function usageNeedsSilero(usage: VoiceUsage): boolean {
	return usage === "conversation";
}

export function parseUsageChoice(label: string | undefined): VoiceUsage | undefined {
	if (!label) return undefined;
	if (label.startsWith("Conversation")) return "conversation";
	if (label.startsWith("Dictation")) return "dictation";
	if (label.startsWith("Listen")) return "listen";
	return undefined;
}

/** Dictation adds to what is already typed instead of replacing it. */
export function appendDictatedText(existing: string, dictated: string): string {
	const head = existing.trimEnd();
	const tail = dictated.trim();
	if (!tail) return existing;
	return head ? `${head} ${tail}` : tail;
}

export function describeVoiceUsage(usage: VoiceUsage): string {
	if (usage === "dictation") return "dictation only: speech to text in the editor, nothing is read aloud";
	if (usage === "listen") return "listen only: replies are read aloud, the microphone stays off";
	return "conversation: talk, hear the reply, and the microphone opens again";
}
