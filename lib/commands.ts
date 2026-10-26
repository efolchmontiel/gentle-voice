/**
 * `/gentle-voice` argument parsing and help text.
 * Lab-only subcommands (test-speak) are never listed in public help and require
 * GENTLE_VOICE_LAB=1 — they are not part of VoiceCommandName / public package surface.
 */

import type { VoiceCommandName, VoiceMode } from "./contracts.ts";

export const VOICE_COMMAND = "gentle-voice" as const;

export const VOICE_SUBCOMMANDS: readonly VoiceCommandName[] = [
	"",
	"on",
	"off",
	"listen",
	"stop",
	"mute",
	"status",
	"config",
	"setup",
	"storage",
	"send",
	"draft",
	"edit",
	"converse",
	"purge",
	"stream",
	"voice-ai",
	"add",
	"barge-in",
	"tts",
	"lang",
	"mode",
	"vibevoice-setup",
] as const;

/** Lab-only — not in VoiceCommandName; gated by isGentleVoiceLabMode(). */
export const LAB_VOICE_SUBCOMMANDS = [
	"test-speak",
	"ab-compare",
	"ab-score",
	/** Conversational reply style (session appendSystemPrompt) — not hands-free converse. */
	"converse-style",
	/** Ensure OpenSource has voice-ai role (MiMo); does not change orchestrator/active. */
	"voice-ai-profile",
] as const;
export type LabVoiceSubcommand = (typeof LAB_VOICE_SUBCOMMANDS)[number];

export function isGentleVoiceLabMode(): boolean {
	return process.env.GENTLE_VOICE_LAB === "1";
}

export interface ParsedVoiceArgs {
	readonly command: VoiceCommandName;
	readonly rest: string;
	readonly error?: string;
	/** Set only when lab mode accepts a lab subcommand. */
	readonly labCommand?: LabVoiceSubcommand;
}

export function parseVoiceArgs(raw: string): ParsedVoiceArgs {
	const trimmed = raw.trim();
	if (!trimmed) return { command: "", rest: "" };
	const [head = "", ...tail] = trimmed.split(/\s+/);
	const lower = head.toLowerCase();

	if ((LAB_VOICE_SUBCOMMANDS as readonly string[]).includes(lower)) {
		if (!isGentleVoiceLabMode()) {
			return {
				command: "",
				rest: trimmed,
				error: `Unknown subcommand "${head}". Try: on|off|listen|stop|mute|status|config|setup|storage|send|draft|edit|converse|purge|stream|voice-ai|add|barge-in|tts|lang|mode|vibevoice-setup`,
			};
		}
		return {
			command: "",
			rest: tail.join(" "),
			labCommand: lower as LabVoiceSubcommand,
		};
	}

	const command = lower as VoiceCommandName;
	if (!VOICE_SUBCOMMANDS.includes(command)) {
		return {
			command: "",
			rest: trimmed,
			error: `Unknown subcommand "${head}". Try: on|off|listen|stop|mute|status|config|setup|storage|send|draft|edit|converse|purge|stream|voice-ai|add|barge-in|tts|lang|mode|vibevoice-setup`,
		};
	}
	return { command, rest: tail.join(" ") };
}

export function parseModeFlag(rest: string): VoiceMode | undefined {
	const value = rest.trim().toLowerCase();
	if (value === "dictation" || value === "conversation" || value === "silent" || value === "listen") return value;
	return undefined;
}

export function voiceHelpText(options?: { includeLab?: boolean }): string {
	const lines = [
		"Gentle Voice — local STT/TTS conversation for Pi and Gentle Shell.",
		"",
		"Usage:",
		"  /gentle-voice              Toggle enabled, or show status when already on",
		"  /gentle-voice on           Enable voice session",
		"  /gentle-voice off          Disable and cancel in-flight audio work",
		"  /gentle-voice converse on  Start hands-free conversation (VAD → auto-submit → TTS → listen)",
		"  /gentle-voice converse off End conversation session (keeps engines installed)",
		"  /gentle-voice listen       Start a single listen window",
		"  /gentle-voice stop         Stop listen/speak and return to idle",
		"  /gentle-voice mute         Mute TTS (STT may continue)",
		"  /gentle-voice draft <text> Replace pending transcript before send",
		"  /gentle-voice send         Send pending transcript (dictation / manual review)",
		"  /gentle-voice edit         Load pending/last voice text into Pi editor (Ctrl+Alt+E)",
		"  /gentle-voice status       Engines, conversation, shortcuts, storage (honest fields)",
		"  /gentle-voice config       Effective config / path resolution hints",
		"  /gentle-voice setup        First-run readiness (consent-gated downloads)",
		"  /gentle-voice storage      Host isolation + private data dirs (cleanup dry-run)",
		"  /gentle-voice purge        Show data-cleanup plan (requires confirm token to delete)",
		"  /gentle-voice purge --keep-models   Same plan but preserve models/voices",
		"  /gentle-voice stream auto|pcm|wav  VibeVoice playback. auto uses PCM when supported",
		"  /gentle-voice voice-ai on|off|status  Narration model (does not change the written reply)",
		"  /gentle-voice add voice-ai   Add an empty voice-ai role to every existing profile",
		"  /gentle-voice barge-in on|off|status  Interrupt playback by speaking",
		"  /gentle-voice tts piper|vibevoice|kokoro  Select the TTS engine for this session",
		"  /gentle-voice mode conversation|dictation|listen  Talk and hear replies, dictation only (no voice), or listen only (no microphone)",
		"  /gentle-voice lang auto|es|en  Language you speak and the voice replies in (auto: Spanish or English per turn)",
		"  /gentle-voice vibevoice-setup  Install VibeVoice after confirm. `plan` prints the terms. `cancel` stops the running install",
	];
	if (options?.includeLab || isGentleVoiceLabMode()) {
		lines.push(
			"  /gentle-voice test-speak     [lab] Fixed phrase TTS+playback (no LLM)",
			"  /gentle-voice ab-compare [n] [engine] [lab] Play fixed phrase n (piper|kokoro|vibevoice)",
			"  /gentle-voice ab-score <1-5>  [lab] Rate last A/B trial naturalness",
			"  /gentle-voice converse-style on|off|status  [lab] Session conversational reply style (1 LLM/turn)",
			"  /gentle-voice voice-ai-profile [lab] Ensure OpenSource has role voice-ai; orchestrator unchanged",
		);
	}
	lines.push(
		"",
		"Shortcuts (when the host accepts them):",
		"  Ctrl+Alt+Space  Start/stop hands-free conversation",
		"  Ctrl+Alt+E      Edit pending / last voice transcript in the Pi editor",
		"  Esc             Cancel playback/generation only while voice is busy",
		"  Disable chords: GENTLE_VOICE_DISABLE_SHORTCUTS=1",
		"",
		"Modes: conversation (auto-submit while session is on) | dictation (manual send) | silent",
		"Mic stays off until you start a session (shortcut or converse on / listen).",
		"Package remove: `pi remove npm:gentle-voice` (keeps private data).",
		"Data remove: `/gentle-voice purge` then confirm, or `gentle-voice-cleanup` CLI.",
		"Keep models for reinstall: add `--keep-models` to purge / cleanup.",
		"Does not narrate tools, subagents, or thinking.",
	);
	return lines.join("\n");
}
