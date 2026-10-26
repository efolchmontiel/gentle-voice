/**
 * Pure voice session state machine — no I/O.
 * Modes (dictation/conversation/silent) and muted flag are orthogonal to phase.
 */

import type { VoiceMode, VoicePhase } from "./contracts.ts";

export interface VoiceMachineState {
	readonly enabled: boolean;
	readonly mode: VoiceMode;
	readonly muted: boolean;
	readonly phase: VoicePhase;
	readonly lastError?: string;
}

export type VoiceMachineEvent =
	| { type: "ENABLE" }
	| { type: "DISABLE" }
	| { type: "SET_MODE"; mode: VoiceMode }
	| { type: "MUTE" }
	| { type: "UNMUTE" }
	| { type: "LISTEN" }
	| { type: "CAPTURE_DONE" }
	| { type: "TRANSCRIBE_DONE"; text: string }
	| { type: "TRANSCRIBE_REVIEW"; text: string }
	| { type: "TRANSCRIBE_EMPTY"; detail?: string }
	/** Explicit user send of a reviewed draft (phase idle → agent). */
	| { type: "SUBMIT_REVIEW"; text: string }
	| { type: "AGENT_STARTED" }
	| { type: "AGENT_SETTLED"; speak: boolean }
	/**
	 * Playback is owned by the stream queue (Voice AI). Enter speaking
	 * without start_tts — an empty start_tts would SPEAK_DONE immediately
	 * and tear down the barge monitor while audio is still playing.
	 */
	| { type: "ENTER_SPEAKING" }
	/** Lab / direct utterance (e.g. test-speak) — respects mute. */
	| { type: "SPEAK_NOW" }
	| { type: "SPEAK_DONE" }
	/**
	 * Human interrupted playback. Cancels TTS audio only.
	 * Does not abort the orchestrator, tools, or background jobs.
	 */
	| { type: "BARGE_COMMIT" }
	/**
	 * Same audio cancel while Voice AI is still preparing the narration
	 * (phase awaiting_agent). Not used while the orchestrator is in tools.
	 */
	| { type: "BARGE_COMMIT_VOICE" }
	| { type: "STOP" }
	| { type: "FAIL"; error: string };

export interface VoiceTransition {
	readonly state: VoiceMachineState;
	readonly changed: boolean;
	/** Side-effect hints for the session controller (still pure: no I/O here). */
	readonly effects: readonly VoiceEffect[];
}

export type VoiceEffect =
	| { type: "start_capture" }
	| { type: "stop_capture" }
	| { type: "cancel_stt" }
	| { type: "cancel_tts" }
	| { type: "cancel_playback" }
	| { type: "submit_transcript"; text: string }
	| { type: "present_transcript"; text: string }
	| { type: "start_tts" }
	| { type: "notify"; level: "info" | "warning" | "error"; message: string };

export function initialVoiceState(partial?: Partial<VoiceMachineState>): VoiceMachineState {
	return {
		enabled: false,
		mode: "conversation",
		muted: false,
		phase: "idle",
		...partial,
	};
}

function withPhase(state: VoiceMachineState, phase: VoicePhase, lastError?: string): VoiceMachineState {
	return {
		enabled: state.enabled,
		mode: state.mode,
		muted: state.muted,
		phase,
		...(lastError !== undefined ? { lastError } : phase === "error" ? {} : {}),
	};
}

function unchanged(state: VoiceMachineState): VoiceTransition {
	return { state, changed: false, effects: [] };
}

function next(state: VoiceMachineState, effects: VoiceEffect[] = []): VoiceTransition {
	return { state, changed: true, effects };
}

/**
 * Reduce one event. Illegal transitions are no-ops (changed:false) except FAIL/STOP/DISABLE
 * which always attempt to return to a safe idle-like state.
 */
export function reduceVoiceState(state: VoiceMachineState, event: VoiceMachineEvent): VoiceTransition {
	switch (event.type) {
		case "ENABLE":
			if (state.enabled) return unchanged(state);
			return next({ ...state, enabled: true, phase: "idle" }, [
				{ type: "notify", level: "info", message: "Voice enabled." },
			]);
		case "DISABLE": {
			const { lastError: _drop, ...rest } = state;
			return next(
				{ ...rest, enabled: false, phase: "idle" },
				cancelAllActive(state),
			);
		}
		case "SET_MODE":
			if (state.mode === event.mode) return unchanged(state);
			return next({ ...state, mode: event.mode });
		case "MUTE":
			if (state.muted) return unchanged(state);
			return next(
				{ ...state, muted: true },
				state.phase === "speaking" ? [{ type: "cancel_tts" }, { type: "cancel_playback" }] : [],
			);
		case "UNMUTE":
			if (!state.muted) return unchanged(state);
			return next({ ...state, muted: false });
		case "LISTEN": {
			if (!state.enabled) {
				return next(state, [{ type: "notify", level: "warning", message: "Voice is off. Use /gentle-voice on first." }]);
			}
			if (state.phase === "listening" || state.phase === "transcribing") return unchanged(state);
			if (state.mode === "listen") {
				return next(state, [{
					type: "notify",
					level: "warning",
					message: "Listen-only mode keeps the microphone off. /gentle-voice mode conversation or dictation turns it on.",
				}]);
			}
			// Prevent accidental capture while the agent turn is open (ghost STT / echo).
			if (state.phase === "awaiting_agent") {
				return next(state, [{
					type: "notify",
					level: "warning",
					message: "Agent is still working — wait before a new listen.",
				}]);
			}
			const cancelSpeaking = state.phase === "speaking"
				? [{ type: "cancel_tts" as const }, { type: "cancel_playback" as const }]
				: [];
			return next(withPhase(state, "listening"), [...cancelSpeaking, { type: "start_capture" }]);
		}
		case "CAPTURE_DONE":
			if (state.phase !== "listening") return unchanged(state);
			return next(withPhase(state, "transcribing"));
		case "TRANSCRIBE_EMPTY": {
			if (state.phase !== "transcribing") return unchanged(state);
			const detail = event.detail?.trim();
			return next(withPhase(state, "idle"), [
				{
					type: "notify",
					level: "info",
					message: detail ? `No speech detected. ${detail}` : "No speech detected.",
				},
			]);
		}
		case "TRANSCRIBE_REVIEW": {
			if (state.phase !== "transcribing") return unchanged(state);
			const text = event.text.trim();
			if (!text) {
				return reduceVoiceState(state, { type: "TRANSCRIBE_EMPTY" });
			}
			// Single present path — extension owns the review instructions notify.
			return next(withPhase(state, "idle"), [
				{ type: "present_transcript", text },
			]);
		}
		case "SUBMIT_REVIEW": {
			if (!state.enabled) {
				return next(state, [{
					type: "notify",
					level: "warning",
					message: "Voice is off. Use /gentle-voice on first.",
				}]);
			}
			if (state.phase === "awaiting_agent" || state.phase === "speaking") {
				return next(state, [{
					type: "notify",
					level: "warning",
					message: "Busy — wait for the agent/TTS to finish before sending again.",
				}]);
			}
			const text = event.text.trim();
			if (!text) {
				return next(state, [{
					type: "notify",
					level: "warning",
					message: "Nothing to send (empty transcript).",
				}]);
			}
			if (state.mode === "dictation") {
				return next(withPhase(state, "idle"), [{ type: "submit_transcript", text }]);
			}
			return next(withPhase(state, "awaiting_agent"), [{ type: "submit_transcript", text }]);
		}
		case "TRANSCRIBE_DONE": {
			if (state.phase !== "transcribing") return unchanged(state);
			const text = event.text.trim();
			if (!text) {
				return reduceVoiceState(state, { type: "TRANSCRIBE_EMPTY" });
			}
			if (state.mode === "dictation") {
				return next(withPhase(state, "idle"), [{ type: "submit_transcript", text }]);
			}
			// conversation and silent both submit; silent only skips later TTS
			return next(withPhase(state, "awaiting_agent"), [{ type: "submit_transcript", text }]);
		}
		case "AGENT_STARTED":
			if (state.phase !== "awaiting_agent" && state.phase !== "idle") return unchanged(state);
			if (!state.enabled) return unchanged(state);
			return next(withPhase(state, "awaiting_agent"));
		case "AGENT_SETTLED": {
			if (state.phase !== "awaiting_agent") return unchanged(state);
			const shouldSpeak = event.speak
				&& !state.muted
				&& state.mode !== "silent"
				&& state.mode !== "dictation";
			if (shouldSpeak) {
				return next(withPhase(state, "speaking"), [{ type: "start_tts" }]);
			}
			return next(withPhase(state, "idle"));
		}
		case "SPEAK_NOW": {
			// Mute/disabled: no-op without notify — session.speakDirect / command handler
			// own a single clear message so callers do not get stacked warnings.
			if (!state.enabled || state.muted) {
				return unchanged(state);
			}
			const cancelSpeaking = state.phase === "speaking"
				? [{ type: "cancel_tts" as const }, { type: "cancel_playback" as const }]
				: [];
			return next(withPhase(state, "speaking"), [...cancelSpeaking, { type: "start_tts" }]);
		}
		case "SPEAK_DONE":
			if (state.phase !== "speaking") return unchanged(state);
			return next(withPhase(state, "idle"));
		case "ENTER_SPEAKING":
			if (state.phase === "speaking") return unchanged(state);
			if (state.phase !== "awaiting_agent") return unchanged(state);
			return next(withPhase(state, "speaking"));
		case "BARGE_COMMIT": {
			if (state.phase !== "speaking") return unchanged(state);
			return next(withPhase(state, "listening"), [
				{ type: "cancel_tts" },
				{ type: "cancel_playback" },
			]);
		}
		case "BARGE_COMMIT_VOICE": {
			if (state.phase !== "awaiting_agent") return unchanged(state);
			return next(withPhase(state, "listening"), [
				{ type: "cancel_tts" },
				{ type: "cancel_playback" },
			]);
		}
		case "STOP":
			return next(withPhase({ ...state, lastError: undefined }, "idle"), cancelAllActive(state));
		case "FAIL":
			return next(withPhase({ ...state, lastError: event.error }, "error"), [
				...cancelAllActive(state),
				{ type: "notify", level: "error", message: event.error },
			]);
		default: {
			const _exhaustive: never = event;
			return unchanged(state);
		}
	}
}

function cancelAllActive(state: VoiceMachineState): VoiceEffect[] {
	const effects: VoiceEffect[] = [];
	if (state.phase === "listening") effects.push({ type: "stop_capture" });
	if (state.phase === "transcribing") effects.push({ type: "cancel_stt" });
	if (state.phase === "speaking") {
		effects.push({ type: "cancel_tts" });
		effects.push({ type: "cancel_playback" });
	}
	return effects;
}

export function describeVoiceStatus(state: VoiceMachineState): string {
	const bits = [
		state.enabled ? "on" : "off",
		`mode=${state.mode}`,
		state.muted ? "muted" : "unmuted",
		`phase=${state.phase}`,
	];
	if (state.lastError) bits.push(`error=${state.lastError}`);
	return bits.join(" · ");
}
