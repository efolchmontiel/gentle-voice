/**
 * Optional conversational reply style for Gentle Voice (lab / session).
 * Injects into Pi `before_agent_start` → systemPromptOptions.appendSystemPrompt.
 * One LLM turn — never a second paraphrase model.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VoiceLanguageMode } from "./language/voice-language.ts";

/** Marker so re-injection is idempotent and removable by presence check. */
export const CONVERSE_STYLE_MARKER = "<!-- gentle-voice:converse-style -->";

/**
 * Session-scoped style block. Written Spanish requirements; does not rewrite
 * TTS or invent tool results.
 */
const LANGUAGE_LINE: Record<VoiceLanguageMode, string> = {
	auto: "Respondé en el idioma en que te habla el usuario: español natural por defecto, inglés natural si te habla en inglés. Conversacional, como un asistente de voz — no como un documento técnico leído en voz alta.",
	es: "Respondé en español natural y conversacional, como un asistente de voz — no como un documento técnico leído en voz alta.",
	en: "Respondé en inglés natural y conversacional (la voz habla inglés), como un asistente de voz — no como un documento técnico leído en voz alta.",
};

export function converseStylePrompt(language: VoiceLanguageMode = "auto"): string {
	return CONVERSE_STYLE_PROMPT.replace(LANGUAGE_LINE.auto, LANGUAGE_LINE[language]);
}

export const CONVERSE_STYLE_PROMPT = `${CONVERSE_STYLE_MARKER}
# Estilo conversacional (Gentle Voice)

${LANGUAGE_LINE.auto}

- Explicá conceptos técnicos en términos sencillos cuando el usuario lo pida o cuando ayude a entender.
- Sé directo; evitá listas innecesarias salvo que el usuario las pida o la claridad lo exija.
- No repitas saludos ni muletillas ("claro", "por supuesto", "¡genial!") en cada turno.
- Mantené precisión técnica; no inventes resultados de herramientas ni datos que no tengas.
- Si el usuario pide detalle, dale detalle; no omitas información crítica.
- Respetá instrucciones explícitas del usuario y los límites de capacidad de esta sesión.
- El texto escrito es la fuente de verdad; no digas que "vas a hablar" ni meta-comentarios sobre TTS.

Fin del bloque de estilo conversacional.`;

export interface ConverseStyleState {
	readonly enabled: boolean;
	readonly updatedAt: string;
}

export function appendSystemPromptOnce(
	options: { appendSystemPrompt?: string } | null | undefined,
	text: string,
): void {
	const normalized = text.replace(/^\n+/, "");
	if (!options || !normalized) return;
	const current = options.appendSystemPrompt ?? "";
	if (current.includes(normalized) || current.includes(CONVERSE_STYLE_MARKER)) return;
	options.appendSystemPrompt = current ? `${current}\n\n${normalized}` : normalized;
}

/** Mutate before_agent_start systemPromptOptions when style is on. */
export function injectConverseStyleIfEnabled(
	systemPromptOptions: { appendSystemPrompt?: string } | null | undefined,
	enabled: boolean,
	language: VoiceLanguageMode = "auto",
): boolean {
	if (!enabled || !systemPromptOptions) return false;
	const before = systemPromptOptions.appendSystemPrompt ?? "";
	appendSystemPromptOnce(systemPromptOptions, converseStylePrompt(language));
	return (systemPromptOptions.appendSystemPrompt ?? "") !== before
		|| before.includes(CONVERSE_STYLE_MARKER);
}

export function converseStyleStatePath(voiceHome: string): string {
	return join(voiceHome, "converse-style.json");
}

export function readConverseStyleState(
	voiceHome: string,
	env: NodeJS.ProcessEnv = process.env,
): ConverseStyleState {
	const fromEnv = env.GENTLE_VOICE_CONVERSE_STYLE?.trim().toLowerCase();
	if (fromEnv === "1" || fromEnv === "on" || fromEnv === "true") {
		return { enabled: true, updatedAt: new Date().toISOString() };
	}
	if (fromEnv === "0" || fromEnv === "off" || fromEnv === "false") {
		return { enabled: false, updatedAt: new Date().toISOString() };
	}
	try {
		const raw = JSON.parse(readFileSync(converseStyleStatePath(voiceHome), "utf8")) as {
			enabled?: unknown;
			updatedAt?: unknown;
		};
		return {
			enabled: raw.enabled === true,
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
		};
	} catch {
		return { enabled: false, updatedAt: new Date(0).toISOString() };
	}
}

export function writeConverseStyleState(voiceHome: string, enabled: boolean): ConverseStyleState {
	const state: ConverseStyleState = {
		enabled,
		updatedAt: new Date().toISOString(),
	};
	const path = converseStyleStatePath(voiceHome);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	return state;
}

export function resolveVoiceHomeForStyle(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.GENTLE_VOICE_HOME?.trim();
	if (home) return home;
	return join(env.HOME ?? "/tmp", ".gentle-voice");
}
