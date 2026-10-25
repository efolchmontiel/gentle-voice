import { VibeVoiceWorkerStartupError } from "./adapters/vibevoice-tts.ts";
/**
 * Session controller: wires state machine + adapters + cancellation.
 * Phase 0 uses stubs; no real Pi agent loop required for unit tests.
 */

import type {
	AssistantMessageLike,
	AudioChunk,
	CaptureAdapter,
	PlaybackAdapter,
	SttAdapter,
	TtsAdapter,
} from "./contracts.ts";
import { openPipewirePcmStream, type RawPcmStream } from "./adapters/pipewire-playback.ts";
import { nativeVibeVoiceStreamEnabled } from "./adapters/vibevoice-pcm.ts";
import type { VoiceConfig } from "./config.ts";
import { DEFAULT_VOICE_CONFIG } from "./config.ts";
import { buildFinalUtterance, extractAssistantPlainText } from "./final-utterance.ts";
import { classifyAssistantForSpeech } from "./narration/final-speech-eligibility.ts";
import type {
	NarrationDiagnostics,
	VoiceNarrationAdapter,
} from "./narration/types.ts";
import { AbortError, CancellationBag, isAbortError } from "./process-cancel.ts";
import { renderForSpeech } from "./tts/speech-renderer.ts";
import {
	applySttCorrections,
	DEFAULT_WHISPER_INITIAL_PROMPT,
	formatCorrectionDiff,
	type SttCorrectionResult,
	type SttCorrectionRule,
} from "./stt/corrections.ts";
import { formatNoSpeechDetail, gateUtteranceForAutoSubmit } from "./stt/utterance-gate.ts";
import {
	createDisabledIncrementalStt,
	createIncrementalSttController,
	isIncrementalSttEnabled,
	type IncrementalSttController,
} from "./stt/incremental-stt.ts";
import { randomUUID } from "node:crypto";
import {
	describeVoiceStatus,
	initialVoiceState,
	reduceVoiceState,
	type VoiceEffect,
	type VoiceMachineEvent,
	type VoiceMachineState,
} from "./state-machine.ts";
import {
	extractTextDeltaFromMessageUpdate,
	isNonSpeakableAssistantEvent,
	SentenceAssembler,
	type AssembledUnit,
} from "./tts/sentence-assembler.ts";
import { StreamSpeakQueue, type StreamSpeakPipeline } from "./tts/stream-speak-queue.ts";
import { createBargeGate, rmsS16le } from "./barge-in/gate.ts";
import { voiceInterruptWindow } from "./barge-in/window.ts";
import {
	bargeTranscriptSubmittable,
	createBargeTranscript,
	type BargeTranscript,
} from "./barge-in/transcript-window.ts";
import { pcmS16leToWav } from "./adapters/wav.ts";
import { VisualMeter } from "./visual/visual-meter.ts";
import type { VoiceChromeVisual } from "./widget-chrome.ts";

/** P0 listen-cycle diagnostics (lab / tests). */
export interface ListenCycleDiag {
	readonly listenRequestedAtMs?: number;
	readonly captureStartedAtMs?: number;
	readonly firstPcmAtMs?: number;
	readonly speechSeenAtMs?: number;
	readonly widgetActivityAtListen?: string;
	readonly micReady: boolean;
}

export interface VoiceSessionDeps {
	config?: VoiceConfig;
	capture: CaptureAdapter;
	stt: SttAdapter;
	tts: TtsAdapter;
	playback: PlaybackAdapter;
	/** Submit transcript to the host agent (injected). */
	submitTranscript?: (text: string) => void | Promise<void>;
	/**
	 * Optional: warm experimental TTS (VibeVoice) while the agent thinks,
	 * so speak is not a cold 30–80s CUDA load after settle.
	 */
	onTranscriptSubmitted?: (text: string) => void;
	/** Phase 2A review path — show text without LLM send. */
	presentTranscript?: (text: string) => void | Promise<void>;
	notify?: (message: string, level: "info" | "warning" | "error") => void;
	now?: () => number;
	/** Optional local STT lexicon (defaults applied when undefined). */
	sttCorrectionRules?: readonly SttCorrectionRule[];
	/** Disable post-corrections (prompt-only). */
	disableSttCorrections?: boolean;
	/** Called when capture VAD ends the utterance (optional). */
	onVadEnd?: () => void;
	/**
	 * Fluent loop hook: after a turn is fully done (TTS finished, muted skip,
	 * or agent settled with nothing to speak). Session schedules echo settle.
	 */
	onSpeakFinished?: () => void;
	/** Throttled chrome repaint (visual meter). */
	onChromeUpdate?: () => void;
	/** Terminal width for narrow wave layout. */
	terminalColumns?: number;
	/** Whisper --prompt used by STT (for prompt-echo gate). */
	whisperInitialPrompt?: string;
	/** Lab diagnostics (no full transcript). */
	onLabDiag?: (line: string) => void;
	/**
	 * Voice AI narrator (optional). When set and voiceAi.enabled, speak path
	 * waits for agent settle, runs a tools-less second inference, then TTS.
	 */
	narrationAdapter?: VoiceNarrationAdapter;
	/** Session id for GS profile binding lookup (optional). */
	sessionId?: () => string | undefined;
	/** Active orchestrator model from ExtensionContext (optional). */
	activeModel?: () => { provider?: string; id: string } | undefined;
	activeThinking?: () => string | undefined;
	/**
	 * Lab barge-in. Default off. When true, a monitor capture may run during
	 * SPEAKING only. It never aborts the orchestrator.
	 */
	bargeInEnabled?: () => boolean;
}

export class VoiceSession {
	#state: VoiceMachineState;
	#config: VoiceConfig;
	#bag = new CancellationBag();
	#bargeAbort: AbortController | undefined;
	#noticeAbort: AbortController | undefined;
	#bargeLatched = false;
	#bargeGate: ReturnType<typeof createBargeGate> | undefined;
	#bargeTranscript: BargeTranscript | undefined;
	#bargeSampleRateHz = 16_000;
	#bargeStartedAt = 0;
	#lastNarrationMs: number | undefined;
	#lastSynthToPlaybackMs: number | undefined;
	#bargeTrace: string[] = [];
	#bargeLastReason = "";
	#bargeFrames = 0;
	#captureStop: (() => Promise<void>) | undefined;
	#pendingSpeakText = "";
	#lastTranscript = "";
	/** Draft awaiting explicit `/gentle-voice send` (review mode). */
	#pendingReviewText = "";
	#lastSubmittedText = "";
	/** True after explicit/auto submit until agent_settled (blocks duplicate send). */
	#submitOpen = false;
	#lastCorrection: SttCorrectionResult | undefined;
	/** Bumped to invalidate in-flight TTS when a newer speak/cancel wins. */
	#speakEpoch = 0;
	/** Esc during WORKING: drop the later narration without aborting the agent. */
	#suppressSettleSpeak = false;
	#pcmTail: Promise<void> = Promise.resolve();
	#live = new Map<AudioChunk, RawPcmStream>();
	#effectChain: Promise<void> = Promise.resolve();
	#meter: VisualMeter;
	#terminalColumns: number;
	/**
	 * When true, chrome shows ●●● instead of scrubbed waves.
	 * Used only if audio cannot yield PCM windows (not for wall-clock estimate).
	 */
	#simpleSpeakingActivity = false;
	#relistenTimer: ReturnType<typeof setTimeout> | undefined;
	#lastLabDiag = "";
	#lastSubmitTurnId = "";
	#lastTtsEngineId = "";
	#lastTtsFallbackReason = "";
	#streamErrorReported = false;
	/** Mic producing PCM (false while ARMING). */
	#micReady = false;
	#listenDiag: ListenCycleDiag = { micReady: false };
	#streamAssembler: SentenceAssembler | undefined;
	#streamQueue = new StreamSpeakQueue(
		() => this.#now(),
		(event) => {
			if (event.type === "drop" || event.type === "cancel") {
				const reason = event.type === "drop" ? event.dropReason : `cancel pending=${event.pending}`;
				this.#labDiagLine(`stream_frag ${event.type} ${"unitId" in event ? event.unitId : ""} ${reason}`);
				if (event.type === "drop" && /^(synth|play):/.test(reason)
					&& !/^(synth|play):(abort|epoch)/.test(reason) && !this.#streamErrorReported) {
					this.#streamErrorReported = true;
					this.deps.notify?.(`Voice reply failed: ${reason.replace(/^(synth|play):/, "")}`, "error");
				}
			} else if (event.type === "play_start" || event.type === "synth_start") {
				this.#labDiagLine(`stream_frag ${event.type} ${event.unitId}`);
			}
		},
	);
	#streamSignal: AbortSignal | undefined;
	#streamActive = false;
	#streamHadAudio = false;
	/** Bumped each agent/stream turn — stale reconcile callbacks must no-op. */
	#streamTurnId = 0;
	/** When true, skip delta streaming; narrate after settle (Voice AI). */
	#deferStreamForNarration = false;
	/** AbortSignal for in-flight Voice AI inference. */
	#narrationSignal: AbortSignal | undefined;
	#lastNarrationDiag: NarrationDiagnostics | undefined;
	/** True while Ctrl+Alt+E / edit holds auto-submit + fluent re-listen. */
	#editHold = false;
	#editWaiter: {
		resolve: (text: string) => void;
		reject: (err: Error) => void;
	} | undefined;
	/** STT latency stages (ms since epoch via deps.now / Date). */
	#sttTiming: SttTimingSnapshot = {};
	/** Provisional incremental STT (UI only; never auto-submits). */
	#incremental: IncrementalSttController | ReturnType<typeof createDisabledIncrementalStt> =
		createDisabledIncrementalStt();
	#provisionalText = "";
	#provisionalKind: "partial" | "final" | "decoding" | undefined;
	/** Bumped each listen start — drops UI from prior capture. */
	#captureGeneration = 0;
	#activeCaptureGeneration = 0;
	#latency = {
		agentStartedAtMs: 0,
		firstTokenAtMs: 0,
		firstSentenceAtMs: 0,
		firstSynthAtMs: 0,
		firstPlaybackAtMs: 0,
		speakFinishedAtMs: 0,
		relistenAtMs: 0,
	};
	readonly deps: VoiceSessionDeps;

	#now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	constructor(deps: VoiceSessionDeps) {
		this.deps = deps;
		this.#config = deps.config ?? DEFAULT_VOICE_CONFIG;
		this.#terminalColumns = deps.terminalColumns ?? 80;
		this.#state = initialVoiceState({
			enabled: this.#config.enabled,
			mode: this.#config.behavior.mode,
			muted: this.#config.behavior.muted || this.#config.behavior.mode === "silent",
		});
		this.#meter = new VisualMeter({
			enabled: this.#config.behavior.visualWaves,
			maxFps: this.#config.behavior.visualFps,
			speechThreshold: this.#config.behavior.vadSpeechThreshold,
			terminalColumns: this.#terminalColumns,
			...(deps.now ? { now: deps.now } : {}),
			onPaint: () => {
				this.deps.onChromeUpdate?.();
			},
		});
		this.#meter.setSimpleSpeakingActivity(false);
	}

	get state(): VoiceMachineState {
		return this.#state;
	}

	get config(): VoiceConfig {
		return this.#config;
	}

	statusLine(): string {
		const base = describeVoiceStatus(this.#state);
		return this.#lastTranscript
			? `${base} · last="${this.#lastTranscript.slice(0, 80)}"`
			: base;
	}

	get lastTranscript(): string {
		return this.#lastTranscript;
	}

	get lastCorrection(): SttCorrectionResult | undefined {
		return this.#lastCorrection;
	}

	get pendingReviewText(): string {
		return this.#pendingReviewText;
	}

	get lastLabDiag(): string {
		return this.#lastLabDiag;
	}

	get lastSubmitTurnId(): string {
		return this.#lastSubmitTurnId;
	}

	get lastTtsEngineId(): string {
		return this.#lastTtsEngineId || this.deps.tts.id;
	}

	get lastTtsFallbackReason(): string {
		return this.#lastTtsFallbackReason;
	}

	get micReady(): boolean {
		return this.#micReady;
	}

	get listenDiag(): ListenCycleDiag {
		return { ...this.#listenDiag };
	}

	get streamMetrics() {
		return this.#streamQueue.metrics;
	}

	get latencySnapshot() {
		return { ...this.#latency };
	}

	get streamActive(): boolean {
		return this.#streamActive;
	}

	get editHold(): boolean {
		return this.#editHold;
	}

	get streamTurnId(): number {
		return this.#streamTurnId;
	}

	/** Exact last transcript voice submitted (for /gentle-voice edit). */
	get lastSubmittedText(): string {
		return this.#lastSubmittedText;
	}

	get sttTiming(): SttTimingSnapshot {
		return { ...this.#sttTiming };
	}

	/** Provisional transcript shown in chrome (never submitted as-is). */
	get provisionalTranscript(): string {
		return this.#provisionalText;
	}

	get provisionalKind(): "partial" | "final" | "decoding" | undefined {
		return this.#provisionalKind;
	}

	get incrementalSttMetrics() {
		return this.#incremental.metrics;
	}

	/**
	 * Pause auto-submit + fluent re-listen. Does NOT kill an active capture —
	 * call {@link finishListenForEdit} to end capture and keep the PCM.
	 */
	beginEditHold(): void {
		this.#editHold = true;
		this.cancelScheduledListen();
	}

	endEditHold(): void {
		this.#editHold = false;
		if (this.#editWaiter) {
			this.#editWaiter.reject(new Error("edit_hold_ended"));
			this.#editWaiter = undefined;
		}
	}

	#resolveEditWaiter(text: string): void {
		const w = this.#editWaiter;
		this.#editWaiter = undefined;
		w?.resolve(text);
	}

	/**
	 * Capture-aware edit:
	 * - listening/transcribing → hold, finish capture, return CURRENT transcript
	 * - idle with last submit → return that (caller labels as resend)
	 * - silence / empty → empty text
	 */
	async prepareVoiceEdit(): Promise<VoiceEditPrep> {
		if (this.#state.phase === "awaiting_agent" || this.#state.phase === "speaking") {
			return { kind: "busy", text: "" };
		}
		this.beginEditHold();

		if (this.#state.phase === "listening") {
			const wait = this.#armEditWaiter();
			await this.finishListen();
			await this.flush();
			try {
				const text = (await wait).trim();
				if (!text) return { kind: "empty_capture", text: "" };
				this.#pendingReviewText = text;
				return { kind: "current", text };
			} catch {
				return { kind: "empty_capture", text: "" };
			}
		}

		if (this.#state.phase === "transcribing") {
			try {
				const text = (await this.#armEditWaiter()).trim();
				if (!text) return { kind: "empty_capture", text: "" };
				this.#pendingReviewText = text;
				return { kind: "current", text };
			} catch {
				return { kind: "empty_capture", text: "" };
			}
		}

		const last = this.#lastSubmittedText.trim();
		if (last) return { kind: "last", text: last };
		const draft = this.#pendingReviewText.trim();
		if (draft) return { kind: "current", text: draft };
		this.endEditHold();
		return { kind: "empty", text: "" };
	}

	#armEditWaiter(timeoutMs = 90_000): Promise<string> {
		if (this.#pendingReviewText.trim() && this.#state.phase === "idle") {
			return Promise.resolve(this.#pendingReviewText);
		}
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.#editWaiter) {
					this.#editWaiter = undefined;
					reject(new Error("edit_transcript_timeout"));
				}
			}, timeoutMs);
			timer.unref?.();
			this.#editWaiter = {
				resolve: (t) => {
					clearTimeout(timer);
					resolve(t);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			};
		});
	}

	/**
	 * Cancel capture/TTS/stream queue. Does not disable the session.
	 * Used by Esc / edit / new user turn. Does not call host agent abort.
	 */
	cancelVoiceAudio(reason = "cancel"): void {
		this.cancelScheduledListen();
		this.#speakEpoch += 1;
		this.#streamTurnId += 1;
		this.#deferStreamForNarration = false;
		this.#narrationSignal = undefined;
		this.#discardBargeMonitor(true);
		this.#noticeAbort?.abort();
		this.#noticeAbort = undefined;
		if (reason === "escape") this.#suppressSettleSpeak = true;
		else if (reason === "new_submit" || reason === "auto_submit") this.#suppressSettleSpeak = false;
		for (const player of this.#live.values()) void player.stop();
		this.#live.clear();
		this.#pcmTail = Promise.resolve();
		// Drain active capture before/with abort so AbortError is handled and
		// a later Ctrl+Alt+Space cannot trip an orphaned rejection.
		const stopCapture = this.#captureStop;
		this.#captureStop = undefined;
		this.#bag.abortAll();
		if (stopCapture) {
			void Promise.resolve(stopCapture()).catch((error) => {
				if (isAbortError(error)) return;
				const message = error instanceof Error ? error.message : String(error);
				this.dispatch({ type: "FAIL", error: message });
			});
		}
		this.#streamQueue.cancel();
		this.#streamActive = false;
		this.#streamHadAudio = false;
		this.#streamAssembler = undefined;
		this.#streamSignal = undefined;
		this.#pendingSpeakText = "";
		this.#meter.stopPlaybackVisual();
		this.#labDiagLine(`voice_cancel=${reason}`);
		// Stop listen/speak phases. Do NOT stop mid-transcribe — caller may
		// be about to dispatch TRANSCRIBE_DONE (auto-submit).
		if (
			reason === "escape"
			&& (this.#state.phase === "listening"
				|| this.#state.phase === "speaking"
				|| this.#state.phase === "transcribing"
				|| this.#state.phase === "awaiting_agent")
		) {
			this.dispatch({ type: "STOP" });
		} else if (this.#state.phase === "listening" || this.#state.phase === "speaking") {
			this.dispatch({ type: "STOP" });
		}
		this.deps.onChromeUpdate?.();
	}

	/** Replace pending transcript before explicit send (empty clears). */
	setReviewDraft(text: string): void {
		this.#pendingReviewText = text.trim();
		if (this.#pendingReviewText) this.#lastTranscript = this.#pendingReviewText;
	}

	/**
	 * Explicit send to the agent. Rejects empty / duplicate while awaiting.
	 * Does not auto-fire from STT when autoSubmitTranscript is false.
	 */
	async submitPending(overrideText?: string): Promise<
		"sent" | "empty" | "duplicate" | "busy" | "disabled"
	> {
		if (!this.#state.enabled) return "disabled";
		if (this.#submitOpen || this.#state.phase === "awaiting_agent" || this.#state.phase === "speaking") {
			const text = (overrideText ?? this.#pendingReviewText).trim();
			if (this.#submitOpen && text && text === this.#lastSubmittedText) return "duplicate";
			return "busy";
		}
		const text = (overrideText ?? this.#pendingReviewText).trim();
		if (!text) return "empty";
		// Cancel any obsolete TTS from a prior turn before submitting.
		this.cancelVoiceAudio("new_submit");
		this.#editHold = false;
		this.#pendingReviewText = "";
		this.#lastSubmittedText = text;
		this.#lastTranscript = text;
		this.#submitOpen = true;
		this.dispatch({ type: "SUBMIT_REVIEW", text });
		try {
			this.deps.onTranscriptSubmitted?.(text);
		} catch {
			/* never block submit on prewarm hooks */
		}
		await this.flush();
		return "sent";
	}

	/**
	 * Lab / direct speak path (test-speak). Honors mute before any TTS work.
	 * When muted/disabled: returns immediately — no Piper, no WAV, no notify effects.
	 * Caller owns the single user-facing status message.
	 */
	async speakDirect(text: string): Promise<"played" | "muted" | "disabled" | "empty"> {
		const trimmed = text.trim();
		if (!trimmed) return "empty";
		// Fail closed before synthesis: never spawn Piper / write temp WAV while muted.
		if (!this.#state.enabled) return "disabled";
		if (this.#state.muted) {
			this.#pendingSpeakText = "";
			return "muted";
		}
		this.#speakEpoch += 1;
		this.#bag.abortAll();
		this.#pendingSpeakText = renderForSpeech(trimmed, {
			language: this.#config.engines.language === "auto" ? "es" : this.#config.engines.language,
			mode: this.#config.behavior.speechMode,
			cwd: process.cwd(),
		}).spoken;
		this.dispatch({ type: "SPEAK_NOW" });
		await this.flush();
		if (this.#state.muted) return "muted";
		return "played";
	}

	/**
	 * Short notice (approval) that must not move the state machine.
	 * speakDirect() would leave the phase idle while tools are still running.
	 * Skipped while already speaking so it cannot cut the final answer.
	 */
	async playSideNotice(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed || !this.#state.enabled || this.#state.muted) return;
		if (this.#state.mode !== "conversation") return;
		if (this.#state.phase === "speaking" || this.#state.phase === "listening") return;
		this.#noticeAbort?.abort();
		const ac = new AbortController();
		this.#noticeAbort = ac;
		try {
			const spoken = renderForSpeech(trimmed, {
				language: this.#config.engines.language === "auto" ? "es" : this.#config.engines.language,
				mode: this.#config.behavior.speechMode,
				cwd: process.cwd(),
			}).spoken || trimmed;
			const { audio } = await this.deps.tts.synthesize(spoken, { signal: ac.signal });
			if (ac.signal.aborted) return;
			const handle = await this.deps.playback.play(audio, { signal: ac.signal });
			await handle.done;
		} catch (error) {
			if (isAbortError(error) || ac.signal.aborted) return;
			this.#labDiagLine("side_notice_fail");
		} finally {
			if (this.#noticeAbort === ac) this.#noticeAbort = undefined;
		}
	}

	replaceConfig(config: VoiceConfig): void {
		this.#config = config;
		this.#meter.setEnabled(config.behavior.visualWaves);
		this.dispatch({ type: "SET_MODE", mode: config.behavior.mode });
		const silent = (config.behavior.mode as string) === "silent";
		if (config.behavior.muted || silent) {
			this.dispatch({ type: "MUTE" });
		} else if (!config.behavior.muted && this.#state.muted && !silent) {
			this.dispatch({ type: "UNMUTE" });
		}
		if (config.enabled && !this.#state.enabled) this.dispatch({ type: "ENABLE" });
		if (!config.enabled && this.#state.enabled) this.dispatch({ type: "DISABLE" });
	}

	/** Live chrome overlay for updateChrome (real meter only). */
	chromeVisual(): VoiceChromeVisual {
		const wavesOn = this.#config.behavior.visualWaves && !this.#state.muted;
		const stage = this.#meter.speakStage;
		const showWave =
			wavesOn
			&& this.#micReady
			&& (this.#state.phase === "listening"
				|| stage === "speaking"
				|| this.#state.phase === "speaking");
		return {
			speakStage: stage,
			speechDetected: this.#meter.wave.speechDetected,
			...(showWave ? { waveLine: this.#meter.wave.render() } : {}),
			simpleSpeakingActivity: this.#simpleSpeakingActivity,
			terminalColumns: this.#terminalColumns,
			micReady: this.#state.phase === "listening" ? this.#micReady : true,
			...(this.#provisionalKind === "decoding"
				? { transcriptPreviewKind: "decoding" as const }
				: this.#provisionalText
					? {
						transcriptPreview: this.#provisionalText,
						transcriptPreviewKind: this.#provisionalKind ?? "partial",
					}
					: {}),
			...(this.#narrationSignal && !this.#narrationSignal.aborted
				? { narrating: true as const }
				: {}),
		};
	}

	#clearProvisional(): void {
		this.#provisionalText = "";
		this.#provisionalKind = undefined;
		// Seal (not soft reset): stop timers so late whisper cannot paint UI.
		this.#incremental.seal();
	}

	#acceptPartialUi(captureGeneration: number): boolean {
		if (captureGeneration !== this.#activeCaptureGeneration) return false;
		if (this.#incremental.isSealed()) return false;
		const phase = this.#state.phase;
		// Only while this listen is live — never during agent/TTS/idle after submit.
		return phase === "listening";
	}

	#incrementalWanted(): boolean {
		return isIncrementalSttEnabled(this.#config.behavior.incrementalStt);
	}

	/** Perf counters for lab measurement (FPS, paint latency). */
	visualMetrics() {
		return this.#meter.metrics;
	}

	setTerminalColumns(cols: number): void {
		// Full terminal width for chrome narrow/wide decision.
		this.#terminalColumns = Math.max(20, cols);
		// Cap wave bars to ~header text length (avoid full-terminal "waybar").
		this.#meter.setTerminalColumns(Math.min(this.#terminalColumns, 44));
	}

	/**
	 * Drop the playback monitor without transcribing.
	 * force=true also drops a latched interruption (Esc).
	 */
	#discardBargeMonitor(force = false): void {
		if (!this.#bargeAbort) return;
		if (this.#bargeLatched && !force) return;
		this.#bargeLatched = false;
		this.#bargeGate = undefined;
		this.#bargeTranscript?.clear();
		this.#bargeTranscript = undefined;
		const ac = this.#bargeAbort;
		this.#bargeAbort = undefined;
		const stop = this.#captureStop;
		this.#captureStop = undefined;
		ac.abort();
		if (stop) {
			void Promise.resolve(stop()).catch(() => {});
		}
	}

	/**
	 * Side capture during SPEAKING only. Frames never reach STT until the gate
	 * confirms. Confirm cancels playback, not the orchestrator.
	 */
	async #armBargeMonitor(): Promise<void> {
		if (!this.deps.bargeInEnabled?.()) {
			this.#noteBarge("skip enabled=0");
			return;
		}
		if (this.#state.muted) {
			this.#noteBarge("skip muted");
			return;
		}
		if (this.#state.phase !== "speaking" && !this.#voicePrepOpen()) {
			this.#noteBarge(`skip phase=${this.#state.phase}`);
			return;
		}
		if (this.#bargeAbort || this.#captureStop) {
			this.#noteBarge("skip already_capturing");
			return;
		}
		const ac = new AbortController();
		this.#bargeAbort = ac;
		this.#bargeLatched = false;
		this.#bargeGate = createBargeGate();
		this.#bargeTranscript = createBargeTranscript();
		this.#bargeSampleRateHz = 16_000;
		this.#bargeStartedAt = this.#now();
		this.#bargeLastReason = "";
		this.#bargeFrames = 0;
		const signal = ac.signal;
		this.#noteBarge("arm phase=speaking");
		try {
			const session = await this.deps.capture.start({
				signal,
				vadArmDelayMs: 0,
				holdVadEnd: () => !this.#bargeLatched,
				onFirstPcm: () => {
					this.#noteBarge("mic_ready");
				},
				onPcmChunk: (pcm, meta) => {
					if (signal.aborted) return;
					const atMs = this.#now() - this.#bargeStartedAt;
					this.#bargeSampleRateHz = meta.sampleRateHz || this.#bargeSampleRateHz;
					if (this.#bargeLatched) {
						this.#bargeTranscript?.pushDuringRun(atMs, pcm);
						return;
					}
					const gate = this.#bargeGate;
					if (!gate) return;
					this.#bargeFrames += 1;
					const micRms = rmsS16le(pcm, meta.channels);
					const playbackRms = this.#meter.playbackLevel();
					const decision = gate.push({
						atMs,
						micRms,
						playbackRms,
					});
					this.#bargeTranscript?.observe(atMs, pcm, decision.runStartMs);
					const changed = decision.reason !== this.#bargeLastReason;
					const sample = this.#bargeFrames === 1 || this.#bargeFrames % 25 === 0;
					if (changed || sample) {
						this.#bargeLastReason = decision.reason;
						this.#noteBarge(
							`frame n=${this.#bargeFrames} mic=${micRms.toFixed(3)} play=${playbackRms.toFixed(3)} floor=${decision.echoFloor.toFixed(3)} reason=${decision.reason}`,
						);
					}
					if (!decision.confirmed) return;
					this.#bargeLatched = true;
					this.#noteBarge(
						`commit onsetMs=${decision.runStartMs ?? -1} sttBytes=${this.#bargeTranscript?.pcm().byteLength ?? 0}`,
					);
					this.#speakEpoch += 1;
					this.#streamTurnId += 1;
					this.deps.notify?.("Barge-in: audio cortado. Seguí hablando.", "info");
					const preparing = this.#state.phase === "awaiting_agent";
					this.dispatch({ type: preparing ? "BARGE_COMMIT_VOICE" : "BARGE_COMMIT" });
					void this.flush();
				},
			});
			this.#captureStop = async () => {
				try {
					const captured = await session.stop(signal);
					const transcript = this.#bargeTranscript;
					const kept = transcript?.pcm() ?? new Uint8Array();
					const anchored = transcript?.anchored() ?? false;
					const rate = captured.sampleRateHz || this.#bargeSampleRateHz;
					transcript?.clear();
					this.#bargeTranscript = undefined;
					if (signal.aborted || !this.#bargeLatched) {
						this.#labDiagLine("barge_discard");
						return;
					}
					this.#bargeLatched = false;
					this.#bargeAbort = undefined;
					this.#bargeGate = undefined;
					this.#micReady = false;
					this.dispatch({ type: "CAPTURE_DONE" });
					const channels = captured.channels === 2 ? 2 : 1;
					if (!anchored || !bargeTranscriptSubmittable(kept.byteLength, rate, channels)) {
						this.#noteBarge(
							`stt_withheld anchored=${anchored} bytes=${kept.byteLength} captureBytes=${captured.bytes.byteLength}`,
						);
						this.dispatch({
							type: "TRANSCRIBE_EMPTY",
							detail: "Barge-in audio was not separated from playback. Nothing was sent.",
						});
						return;
					}
					this.#noteBarge(
						`stt_window bytes=${kept.byteLength} captureBytes=${captured.bytes.byteLength} rate=${rate}`,
					);
					await this.#transcribe({
						bytes: pcmS16leToWav(kept, rate, channels),
						sampleRateHz: rate,
						channels,
						format: "wav",
						...(captured.captureMeta
							? { captureMeta: { ...captured.captureMeta, speechSeen: true } }
							: {
								captureMeta: {
									captureId: "barge",
									speechSeen: true,
									endReason: "vad" as const,
									durationMs: Math.round((kept.byteLength / (rate * channels * 2)) * 1000),
									peakRms: 0,
									meanRms: 0,
								},
							}),
					}, signal);
				} catch (error) {
					this.#bargeLatched = false;
					this.#bargeAbort = undefined;
					this.#bargeTranscript?.clear();
					this.#bargeTranscript = undefined;
					if (isAbortError(error) || signal.aborted) return;
					throw error;
				}
			};
			this.#labDiagLine("barge_monitor_on");
		} catch (error) {
			this.#bargeAbort = undefined;
			this.#bargeGate = undefined;
			this.#bargeTranscript?.clear();
			this.#bargeTranscript = undefined;
			if (!isAbortError(error)) {
				this.#labDiagLine("barge_arm_fail");
			}
		}
	}

	/** Cancel pending fluent re-listen (session end / dispose). */
	cancelScheduledListen(): void {
		if (this.#relistenTimer) {
			clearTimeout(this.#relistenTimer);
			this.#relistenTimer = undefined;
		}
	}

	/**
	 * After a conversation turn settles: open capture immediately.
	 * Echo settle is applied as VAD arm delay inside capture (PCM buffered,
	 * chrome shows ARMING until first sample — not fake LISTENING).
	 */
	scheduleFluentRelisten(): void {
		if (!this.#bargeLatched) this.#discardBargeMonitor();
		if (!this.#config.behavior.fluentConversation) return;
		if (!this.#state.enabled) return;
		if (this.#state.mode === "dictation") return;
		if (this.#editHold) return;
		if (this.#streamActive || this.#streamQueue.isBusy) return;
		this.cancelScheduledListen();
		// Tiny teardown only — real echo hold is vadArmDelayMs on capture start.
		const delay = 0;
		this.#latency = { ...this.#latency, relistenAtMs: this.#now() };
		this.#relistenTimer = setTimeout(() => {
			this.#relistenTimer = undefined;
			if (!this.#config.behavior.fluentConversation) return;
			if (!this.#state.enabled) return;
			if (this.#editHold) return;
			if (this.#streamActive || this.#streamQueue.isBusy) return;
			if (this.#state.phase === "listening" || this.#state.phase === "speaking") return;
			if (this.#state.phase === "awaiting_agent" || this.#state.phase === "transcribing") return;
			this.#listenDiag = {
				listenRequestedAtMs: this.#now(),
				micReady: false,
				widgetActivityAtListen: "ARMING",
			};
			this.#micReady = false;
			this.dispatch({ type: "LISTEN" });
			void this.flush().then(() => this.deps.onChromeUpdate?.());
		}, delay);
		this.#relistenTimer.unref?.();
	}

	/** Voice AI after_settle: defer delta streaming until narrated text is ready. */
	#voiceAiNarrationWanted(): boolean {
		const ai = this.#config.voiceAi;
		return Boolean(
			ai?.enabled
			&& ai.streaming === "after_settle"
			&& this.deps.narrationAdapter,
		);
	}

	narrationDiagnostics(): NarrationDiagnostics | undefined {
		return this.deps.narrationAdapter?.lastDiagnostics() ?? this.#lastNarrationDiag;
	}

	/** Recent barge decisions. RMS and reasons only — no audio, no transcript. */
	bargeTrace(): readonly string[] {
		return this.#bargeTrace;
	}

	/** Last turn stage clocks. Absent until that stage has happened. */
	lastVoiceTiming(): { readonly narrationMs?: number; readonly synthToPlaybackMs?: number } {
		return {
			...(this.#lastNarrationMs !== undefined ? { narrationMs: this.#lastNarrationMs } : {}),
			...(this.#lastSynthToPlaybackMs !== undefined
				? { synthToPlaybackMs: this.#lastSynthToPlaybackMs }
				: {}),
		};
	}

	#noteVoicePlayback(): void {
		if (this.#latency.firstSynthAtMs && this.#latency.firstPlaybackAtMs) {
			this.#lastSynthToPlaybackMs = Math.max(
				0,
				this.#latency.firstPlaybackAtMs - this.#latency.firstSynthAtMs,
			);
		}
	}

	#voicePrepOpen(): boolean {
		const stage = this.#meter.speakStage;
		return voiceInterruptWindow({
			phase: this.#state.phase,
			narrating: Boolean(this.#narrationSignal && !this.#narrationSignal.aborted),
			synthesizing: stage === "synthesizing" || stage === "loading_voice",
		});
	}

	/** Drop a learned quiet floor when real playback starts, so speaker onset is not a barge. */
	#rebaseBargeFloor(): void {
		if (!this.#bargeAbort || this.#bargeLatched) return;
		this.#bargeGate = createBargeGate();
		this.#bargeStartedAt = this.#now();
		this.#bargeLastReason = "";
		this.#noteBarge("floor_reset playback");
	}

	#noteBarge(line: string): void {
		const entry = `${Math.round(this.#now())} ${line}`;
		this.#bargeTrace = [...this.#bargeTrace, entry].slice(-12);
		this.#labDiagLine(`barge ${line}`);
	}

	/**
	 * Start incremental speak pipeline for the current agent turn.
	 * Persona/style come from Pi text deltas — no rewrite here.
	 * Invalidates any prior turn's queue/playback (no cross-turn audio).
	 * When Voice AI is enabled, defers streaming until settle + narration.
	 */
	beginStreamSpeak(): void {
		if (!this.#state.enabled || this.#state.muted) return;
		if (this.#state.mode !== "conversation") return;
		// Kill obsolete playback from turn A before turn B can stream.
		this.#speakEpoch += 1;
		this.#streamTurnId += 1;
		const turnId = this.#streamTurnId;
		this.#bag.abortAll();
		this.#streamQueue.cancel();
		this.#meter.stopPlaybackVisual();
		this.#pendingSpeakText = "";
		this.#latency = {
			...this.#latency,
			agentStartedAtMs: this.#now(),
			firstTokenAtMs: 0,
			firstSentenceAtMs: 0,
			firstSynthAtMs: 0,
			firstPlaybackAtMs: 0,
			speakFinishedAtMs: 0,
			relistenAtMs: 0,
		};

		if (this.#voiceAiNarrationWanted()) {
			this.#deferStreamForNarration = true;
			this.#streamActive = false;
			this.#streamHadAudio = false;
			this.#streamAssembler = undefined;
			this.#streamSignal = undefined;
			this.#labDiagLine(`stream_deferred=voice_ai turn=${turnId}`);
			return;
		}

		this.#deferStreamForNarration = false;
		this.#armStreamAssembler(turnId);
	}

	#armStreamAssembler(turnId: number): void {
		this.#streamErrorReported = false;
		this.#streamAssembler = new SentenceAssembler({
			language: this.#config.engines.language === "auto" ? "es" : this.#config.engines.language,
			// 2D.5 Strategy B: group short sentences for less choppy prosody.
			minSentencesPerUnit: 2,
			minCharsPerUnit: 140,
			softFlushChars: 280,
			longSentenceChars: 200,
			// 3.6 streaming TTS: first sentence alone for TTFA, then Strategy B.
			earlyFirstUnit: true,
			speechMode: this.#config.behavior.speechMode,
			cwd: process.cwd(),
		});
		this.#streamQueue.begin();
		this.#streamActive = true;
		this.#streamHadAudio = false;
		this.#streamSignal = this.#bag.derive();
		this.#labDiagLine(`stream_begin turn=${turnId}`);
	}

	/**
	 * Feed a Pi `message_update` event. Only `text_delta` is spoken.
	 * Thinking / toolcall events block further speculative streaming.
	 */
	onMessageUpdate(event: unknown): void {
		if (!this.#streamActive || !this.#streamAssembler) return;
		if (this.#state.muted) {
			this.cancelStreamSpeak();
			return;
		}
		if (isNonSpeakableAssistantEvent(event)) {
			this.#streamQueue.markBlocked("tool_or_thinking");
			this.#labDiagLine("stream_blocked=tool_or_thinking");
			return;
		}
		const delta = extractTextDeltaFromMessageUpdate(event);
		if (!delta) return;
		this.#streamQueue.markFirstDelta();
		if (!this.#latency.firstTokenAtMs) {
			this.#latency = { ...this.#latency, firstTokenAtMs: this.#now() };
		}
		const units = this.#streamAssembler.pushDelta(delta);
		if (units.length === 0) return;
		if (!this.#latency.firstSentenceAtMs) {
			this.#latency = { ...this.#latency, firstSentenceAtMs: this.#now() };
		}
		this.#streamQueue.enqueue(units);
		const signal = this.#streamSignal ?? this.#bag.derive();
		void this.#streamQueue.kickPipeline(this.#streamPipeline(), signal);
	}

	cancelStreamSpeak(): void {
		this.#streamActive = false;
		this.#streamAssembler = undefined;
		this.#streamQueue.cancel();
		this.#streamSignal = undefined;
		this.#meter.stopPlaybackVisual();
	}

	/**
	 * Voice AI path: second inference → Speech Renderer → Streaming TTS queue.
	 * Esc / turn change aborts via CancellationBag; cancelled → no playback.
	 */
	async #narrateThenStreamSpeak(
		source: string,
		settleTurnId: number,
		settleEpoch: number,
	): Promise<void> {
		const adapter = this.deps.narrationAdapter;
		if (!adapter) {
			this.#pendingSpeakText = renderForSpeech(source, {
				language: this.#config.engines.language === "auto" ? "es" : this.#config.engines.language,
				mode: this.#config.behavior.speechMode,
				cwd: process.cwd(),
			}).spoken;
			this.dispatch({ type: "AGENT_SETTLED", speak: Boolean(this.#pendingSpeakText) });
			return;
		}

		const signal = this.#bag.derive();
		this.#narrationSignal = signal;
		const active = this.deps.activeModel?.();
		const thinking = this.deps.activeThinking?.();
		this.#labDiagLine("voice_ai_narrate_start");
		this.deps.onChromeUpdate?.();
		void this.#armBargeMonitor();

		let result;
		try {
			result = await adapter.narrate({
				text: source,
				signal,
				timeoutMs: this.#config.voiceAi.timeoutMs,
				maxInputChars: this.#config.voiceAi.maxInputChars,
				style: this.#config.voiceAi.style,
				sessionId: this.deps.sessionId?.(),
				...(active ? { activeModel: active } : {}),
				...(thinking
					? { activeThinking: thinking as import("./narration/types.ts").NarrationThinkingLevel }
					: {}),
			});
		} catch (err) {
			if (isAbortError(err) || signal.aborted) {
				this.#labDiagLine("voice_ai_narrate_cancelled");
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			this.#labDiagLine(`voice_ai_narrate_error=${message.slice(0, 80)}`);
			result = {
				ok: true as const,
				path: "deterministic" as const,
				text: source,
				reason: `adapter_throw:${message.slice(0, 80)}`,
				resolution: { status: "disabled" as const, source: "disabled" as const },
				latencyMs: 0,
			};
		}

		this.#lastNarrationDiag = adapter.lastDiagnostics();
		this.#narrationSignal = undefined;

		// Stale turn / Esc — never play residual audio.
		if (
			signal.aborted
			|| settleTurnId !== this.#streamTurnId
			|| settleEpoch !== this.#speakEpoch
		) {
			this.#labDiagLine("voice_ai_narrate_stale");
			return;
		}

		if (!result.ok && result.path === "cancelled") {
			this.#labDiagLine(`voice_ai_cancelled=${result.reason}`);
			if (this.#state.phase === "awaiting_agent") {
				this.dispatch({ type: "AGENT_SETTLED", speak: false });
			}
			this.deps.onChromeUpdate?.();
			return;
		}

		const narrated = result.ok ? result.text : source;
		if (result.ok && result.path === "llm") {
			this.#lastNarrationMs = result.latencyMs;
		}
		const path = result.ok ? result.path : "deterministic";
		this.#labDiagLine(
			`voice_ai_done path=${path} ms=${result.latencyMs} src=${
				"resolution" in result && result.resolution.status === "ready"
					? result.resolution.model.ref
					: result.resolution.source
			}`,
		);

		const rendered = renderForSpeech(narrated, {
			language: this.#config.engines.language === "auto" ? "es" : this.#config.engines.language,
			mode: this.#config.behavior.speechMode,
			cwd: process.cwd(),
		}).spoken || narrated;

		if (!rendered.trim()) {
			this.dispatch({ type: "AGENT_SETTLED", speak: false });
			this.scheduleFluentRelisten();
			return;
		}

		// Stream narrated text through the approved Streaming TTS pipeline.
		this.#speakEpoch += 1;
		this.#streamTurnId += 1;
		const turnId = this.#streamTurnId;
		this.#armStreamAssembler(turnId);
		const units = this.#streamAssembler!.pushDelta(rendered);
		const flushed = this.#streamAssembler!.flush();
		this.#streamQueue.enqueue([...units, ...flushed]);
		if (!this.#latency.firstTokenAtMs) {
			this.#latency = { ...this.#latency, firstTokenAtMs: this.#now() };
		}
		if (!this.#latency.firstSentenceAtMs && (units.length > 0 || flushed.length > 0)) {
			this.#latency = { ...this.#latency, firstSentenceAtMs: this.#now() };
		}
		const playSignal = this.#streamSignal ?? this.#bag.derive();
		// Stream owns playback. Do not emit start_tts with an empty pending buffer:
		// that SPEAK_DONE discarded the barge monitor while VibeVoice was still talking.
		this.dispatch({ type: "ENTER_SPEAKING" });
		void this.#streamQueue
			.kickPipeline(this.#streamPipeline(), playSignal)
			.then(async () => {
				await this.#streamQueue.idle();
				if (turnId !== this.#streamTurnId) {
					this.#labDiagLine(`voice_ai_stream_stale turn=${turnId}`);
					return;
				}
				this.#streamQueue.markDone();
				this.#latency = { ...this.#latency, speakFinishedAtMs: this.#now() };
				this.#streamAssembler = undefined;
				this.#streamSignal = undefined;
				this.#streamActive = false;
				this.#streamHadAudio = false;
				this.#meter.stopPlaybackVisual();
				if (this.#state.phase === "speaking") {
					this.dispatch({ type: "SPEAK_DONE" });
				}
				this.deps.onSpeakFinished?.();
				this.deps.onChromeUpdate?.();
			});
	}

	#labDiagLine(extra: string): void {
		this.#lastLabDiag = extra;
		this.deps.onLabDiag?.(extra);
	}

	/** Prefetch pipeline: synth unit N+1 while N plays (Piper CPU, depth=1). */
	#streamPipeline(): StreamSpeakPipeline {
		return {
			prefetchDepth: 1,
			synthesize: (unit: AssembledUnit, signal: AbortSignal) =>
				this.#synthStreamUnit(unit.speakable, signal),
			play: (unit: AssembledUnit, audio: AudioChunk, signal: AbortSignal) =>
				this.#playStreamAudio(unit.speakable, audio, signal),
		};
	}

	/** VOICE_LOADING while VV checkpoint loads; SYNTHESIZING only after warm generate. */
	#markTtsChromeStage(): () => void {
		const tts = this.deps.tts as {
			id?: string;
			workerWarm?: boolean;
			isLoadingVoice?: boolean;
			vibevoice?: { workerWarm?: boolean; isLoadingVoice?: boolean };
		};
		const vv = tts.vibevoice ?? tts;
		const isVv = (tts.id ?? "").includes("vibevoice");
		const coldOrLoading =
			isVv && (vv.workerWarm === false || vv.isLoadingVoice === true);
		if (coldOrLoading) {
			this.#meter.beginLoadingVoice();
		} else {
			this.#meter.beginSynthesizing();
		}
		this.deps.onChromeUpdate?.();
		void this.#armBargeMonitor();
		const poll = setInterval(() => {
			const cur = this.deps.tts as typeof tts;
			const engine = cur.vibevoice ?? cur;
			if (engine.workerWarm && !engine.isLoadingVoice) {
				if (this.#meter.speakStage === "loading_voice") {
					this.#meter.beginSynthesizing();
					this.deps.onChromeUpdate?.();
				}
				clearInterval(poll);
			}
		}, 250);
		return () => clearInterval(poll);
	}

	/**
	 * VibeVoice uses native PCM when this host can play float32.
	 * Piper and every other engine stay on their own audio.
	 * If PCM fails before the first frame, the same sentence is synthesized once as WAV.
	 * After any PCM has been written, a failure is not played again.
	 */
	async #synthesizeForPlayback(
		speakable: string,
		signal: AbortSignal,
		stillCurrent: () => boolean,
	): Promise<AudioChunk> {
		const engineId = this.deps.tts.id ?? "";
		const vibevoice = engineId.includes("vibevoice");
		if (!vibevoice || !nativeVibeVoiceStreamEnabled(process.env)) {
			const { audio } = await this.deps.tts.synthesize(speakable, { signal });
			return audio;
		}
		const player = openPipewirePcmStream({
			signal,
			sampleRateHz: 24_000,
			channels: 1,
			format: "f32",
		});
		const token: AudioChunk = {
			bytes: new Uint8Array(1),
			sampleRateHz: 24_000,
			channels: 1,
			format: "raw",
		};
		this.#live.set(token, player);
		const waitPrev = this.#pcmTail;
		let got = false;
		try {
			await this.deps.tts.synthesize(speakable, {
				signal,
				onPcm: async (frame) => {
					await waitPrev;
					if (!stillCurrent()) return;
					player.write(frame.pcm);
					if (!got) {
						got = true;
						this.#simpleSpeakingActivity = true;
						this.#meter.setSimpleSpeakingActivity(true);
						this.#meter.beginSpeakingFromAudio(token);
						this.#rebaseBargeFloor();
						void this.#armBargeMonitor();
						if (!this.#latency.firstPlaybackAtMs) {
							this.#latency = { ...this.#latency, firstPlaybackAtMs: this.#now() };
						}
						this.#noteVoicePlayback();
						this.deps.onChromeUpdate?.();
					}
				},
			});
		} catch (error) {
			await player.stop();
			this.#live.delete(token);
			if (got || signal.aborted || !stillCurrent() || error instanceof VibeVoiceWorkerStartupError) throw error;
			const detail = error instanceof Error ? error.message : String(error);
			this.#lastTtsFallbackReason = `pcm_before_audio:${detail.slice(0, 180)}`;
			this.deps.notify?.(
				`VibeVoice PCM failed before audio (${detail.slice(0, 180)}). Playing this sentence once as WAV.`,
				"warning",
			);
			let audio: AudioChunk;
			try {
				({ audio } = await this.deps.tts.synthesize(speakable, { signal }));
			} catch (wavError) {
				const wavDetail = wavError instanceof Error ? wavError.message : String(wavError);
				this.#lastTtsFallbackReason = `pcm_and_wav_failed:${detail.slice(0, 80)} | ${wavDetail.slice(0, 80)}`;
				if (isAbortError(wavError) || signal.aborted) throw wavError;
				throw new Error(
					`WAV fallback failed (${wavDetail.slice(0, 180)}). PCM: ${detail.slice(0, 180)}`,
				);
			}
			if (!audio.bytes || audio.bytes.byteLength === 0) {
				this.#lastTtsFallbackReason = `wav_empty:${detail.slice(0, 120)}`;
				throw new Error(`WAV fallback produced no audio. PCM: ${detail.slice(0, 180)}`);
			}
			return audio;
		}
		if (!got || !stillCurrent()) {
			await player.stop();
			this.#live.delete(token);
			if (signal.aborted || !stillCurrent()) throw new AbortError();
			this.deps.notify?.(
				"VibeVoice returned no PCM. Playing this sentence once as WAV.",
				"warning",
			);
			const { audio } = await this.deps.tts.synthesize(speakable, { signal });
			return audio;
		}
		this.#pcmTail = player.done;
		return token;
	}

	async #finishLivePlayback(audio: AudioChunk, signal: AbortSignal): Promise<boolean> {
		const live = this.#live.get(audio);
		if (!live) return false;
		this.#live.delete(audio);
		live.finish();
		await live.done;
		if (signal.aborted) throw new AbortError();
		return true;
	}

	async #synthStreamUnit(speakable: string, signal: AbortSignal): Promise<AudioChunk> {
		const turnAtStart = this.#streamTurnId;
		if (!speakable || this.#state.muted || signal.aborted) {
			throw new AbortError();
		}
		if (!this.#latency.firstSynthAtMs) {
			this.#latency = { ...this.#latency, firstSynthAtMs: this.#now() };
		}
		const stopStagePoll = this.#markTtsChromeStage();
		this.#lastTtsEngineId = this.deps.tts.id;
		try {
			const audio = await this.#synthesizeForPlayback(
				speakable,
				signal,
				() => !signal.aborted && !this.#state.muted && turnAtStart === this.#streamTurnId,
			);
			if (signal.aborted || this.#state.muted || turnAtStart !== this.#streamTurnId) {
				throw new AbortError();
			}
			return audio;
		} finally {
			stopStagePoll();
		}
	}

	async #playStreamAudio(
		speakable: string,
		audio: AudioChunk,
		signal: AbortSignal,
	): Promise<void> {
		const turnAtStart = this.#streamTurnId;
		// Never resolve "success" on skip — queue would count a phantom play and advance.
		if (!speakable || this.#state.muted || signal.aborted || turnAtStart !== this.#streamTurnId) {
			throw new AbortError();
		}
		if (!audio.bytes || audio.bytes.byteLength === 0) {
			throw new Error("empty_audio");
		}
		if (await this.#finishLivePlayback(audio, signal)) {
			if (signal.aborted || turnAtStart !== this.#streamTurnId || this.#state.muted) {
				throw new AbortError();
			}
			this.#streamHadAudio = true;
			this.#streamAssembler?.markSpoken(speakable);
			this.#meter.stopPlaybackVisual();
			this.deps.onChromeUpdate?.();
			return;
		}
		const canScrub =
			audio.format === "wav"
			|| audio.format === "pcm_s16le"
			|| audio.format === "raw";
		this.#simpleSpeakingActivity = !canScrub;
		this.#meter.setSimpleSpeakingActivity(!canScrub);
		this.#meter.beginSpeakingFromAudio(audio);
		this.#rebaseBargeFloor();
		void this.#armBargeMonitor();
		this.deps.onChromeUpdate?.();
		if (!this.#latency.firstPlaybackAtMs) {
			this.#latency = { ...this.#latency, firstPlaybackAtMs: this.#now() };
		}
		this.#noteVoicePlayback();
		const handle = await this.deps.playback.play(audio, { signal });
		await handle.done;
		// Cancelled / superseded turn: do not mark as spoken.
		if (signal.aborted || turnAtStart !== this.#streamTurnId || this.#state.muted) {
			throw new AbortError();
		}
		this.#streamHadAudio = true;
		this.#streamAssembler?.markSpoken(speakable);
		this.#meter.stopPlaybackVisual();
		this.deps.onChromeUpdate?.();
	}

	/** Legacy serial synth+play (tests / diagnostics). Prefer kickPipeline. */
	async #playStreamUnit(speakable: string, signal: AbortSignal): Promise<void> {
		const audio = await this.#synthStreamUnit(speakable, signal);
		await this.#playStreamAudio(speakable, audio, signal);
	}

	dispatch(event: VoiceMachineEvent): VoiceMachineState {
		const transition = reduceVoiceState(this.#state, event);
		if (!transition.changed && transition.effects.length === 0) return this.#state;
		this.#state = transition.state;
		// Abort in-flight synth/playback immediately — do not wait for the effect
		// queue (otherwise STOP would only cancel after Piper finished).
		const needsEagerCancel = transition.effects.some(
			(e) =>
				e.type === "cancel_tts"
				|| e.type === "cancel_playback"
				|| e.type === "cancel_stt",
		);
		// Streaming TTS often runs while phase is still awaiting_agent (not speaking),
		// so cancelAllActive may omit cancel_tts. Esc/STOP must still drop the queue.
		const stopDuringStream = event.type === "STOP"
			&& (this.#streamActive || this.#streamQueue.isBusy || this.#streamHadAudio);
		if (needsEagerCancel || stopDuringStream) {
			this.#bag.abortAll();
			if (stopDuringStream) {
				this.#streamQueue.cancel();
				this.#streamActive = false;
				this.#streamHadAudio = false;
				this.#streamAssembler = undefined;
				this.#streamSignal = undefined;
				this.#meter.stopPlaybackVisual();
			}
		}
		this.#effectChain = this.#effectChain.then(() => this.#runEffects(transition.effects));
		return this.#state;
	}

	/** Wait for queued side effects (tests / command handlers). */
	async flush(): Promise<void> {
		await this.#effectChain;
	}

	/**
	 * Host hook: agent run settled — reconcile stream or fallback to full TTS.
	 * Does not rewrite persona; speaks agent text as-is (TTS normalize only).
	 */
	onAgentSettled(input: {
		message?: AssistantMessageLike | null;
		outcome?: "completed" | "aborted" | "error";
	}): FinalSpeakDecision {
		this.#submitOpen = false;
		if (this.#suppressSettleSpeak) {
			this.#suppressSettleSpeak = false;
			this.#deferStreamForNarration = false;
			this.#pendingSpeakText = "";
			if (this.#state.phase === "awaiting_agent") {
				this.dispatch({ type: "AGENT_SETTLED", speak: false });
			}
			this.scheduleFluentRelisten();
			return { speak: false, text: "", reason: "voice_escape", streamed: false };
		}

		const eligibility = classifyAssistantForSpeech(input.message ?? null, input.outcome);
		const utterance = buildFinalUtterance({
			message: input.message,
			outcome: input.outcome,
			maxSentences: this.#config.behavior.maxSpokenSentences,
			maxChars: this.#config.behavior.maxSpokenChars,
		});

		if (utterance.reason === "unfaithful_skip_show_full" && utterance.text) {
			this.deps.notify?.(
				`Reply (written only — not spoken; could not summarize faithfully):\n${utterance.text}`,
				"info",
			);
		}

		const maySpeak = eligibility.speak
			&& this.#state.mode === "conversation"
			&& !this.#state.muted
			&& this.#state.enabled
			&& input.outcome !== "aborted"
			&& (input.outcome !== "error" || this.#config.behavior.speakWarnings);

		const streamMetrics = this.#streamQueue.metrics;
		const streamWasActive = this.#streamActive || this.#streamHadAudio;
		const streamBlocked = streamMetrics.mode === "blocked";
		const settleTurnId = this.#streamTurnId;
		const settleEpoch = this.#speakEpoch;
		// Full assistant plain text — NEVER the maxSpokenSentences summary — for
		// stream reconcile / stream-failure fallback (avoids starting at sentence 3).
		const fullPlain = extractAssistantPlainText(input.message);
		const firstClipLost = streamMetrics.fragmentLog.some(
			(e) =>
				e.type === "drop"
				&& (e.dropReason === "first_synth_failed"
					|| e.dropReason === "first_synth_empty"
					|| e.dropReason === "first_play_failed"
					|| e.dropReason.startsWith("first_")),
		);
		const streamDiedBeforeAudio = streamWasActive
			&& !this.#streamHadAudio
			&& (firstClipLost || streamMetrics.unitsPlayed === 0);

		// ——— Voice AI: narrate after settle, then stream TTS of narrated text ———
		if (
			maySpeak
			&& this.#voiceAiNarrationWanted()
			&& this.#deferStreamForNarration
			&& input.outcome !== "aborted"
		) {
			const source = eligibility.text || fullPlain || utterance.text;
			if (!source.trim()) {
				this.#deferStreamForNarration = false;
				this.dispatch({ type: "AGENT_SETTLED", speak: false });
				this.scheduleFluentRelisten();
				return {
					speak: false,
					text: "",
					reason: `${utterance.reason}+voice_ai_empty`,
					streamed: false,
				};
			}
			this.#deferStreamForNarration = false;
			void this.#narrateThenStreamSpeak(source, settleTurnId, settleEpoch);
			return {
				speak: true,
				text: source,
				reason: `${utterance.reason}+voice_ai_pending`,
				streamed: true,
				narrating: true,
			};
		}

		// ——— Incremental path: flush remainder against FULL reply, not summary ———
		if (
			streamWasActive
			&& maySpeak
			&& !streamBlocked
			&& this.#streamAssembler
			&& !streamDiedBeforeAudio
		) {
			const flushed = this.#streamAssembler.flush();
			this.#streamQueue.enqueue(flushed);
			const remainderSource = fullPlain || utterance.text;
			const remainder = this.#streamAssembler.remainderForFinal(remainderSource);
			if (remainder) {
				this.#streamAssembler.markEmitted(remainder);
				this.#streamQueue.enqueue([{
					id: "reconcile",
					raw: remainder,
					speakable: renderForSpeech(remainder, {
						language: this.#config.engines.language === "auto" ? "es" : this.#config.engines.language,
						mode: this.#config.behavior.speechMode,
						cwd: process.cwd(),
					}).spoken || remainder,
				}]);
			}
			this.#streamActive = false;
			const signal = this.#streamSignal ?? this.#bag.derive();
			void this.#streamQueue
				.kickPipeline(this.#streamPipeline(), signal)
				.then(async () => {
					await this.#streamQueue.idle();
					// Stale settle from turn A after turn B began — do nothing.
					if (settleTurnId !== this.#streamTurnId) {
						this.#labDiagLine(`stream_reconcile_stale turn=${settleTurnId}`);
						return;
					}
					this.#streamQueue.markDone();
					this.#latency = { ...this.#latency, speakFinishedAtMs: this.#now() };
					this.#streamAssembler = undefined;
					this.#streamSignal = undefined;
					this.#streamHadAudio = false;
					this.#meter.stopPlaybackVisual();
					// Leave awaiting_agent → idle without classic start_tts.
					if (this.#state.phase === "awaiting_agent") {
						this.dispatch({ type: "AGENT_SETTLED", speak: false });
					} else if (this.#state.phase === "speaking") {
						this.dispatch({ type: "SPEAK_DONE" });
					}
					this.deps.onSpeakFinished?.();
					this.deps.onChromeUpdate?.();
				});
			return {
				speak: true,
				text: fullPlain || utterance.text,
				reason: `${utterance.reason}+stream_reconcile`,
				streamed: true,
			};
		}

		// Stream blocked / first clip lost → reliable final TTS from the OPENING.
		if (streamWasActive && (streamBlocked || streamDiedBeforeAudio)) {
			this.#streamQueue.cancel();
			this.#streamAssembler = undefined;
			this.#streamActive = false;
			this.#streamQueue.markFallback();
			this.#labDiagLine(
				`stream_fallback=${streamBlocked ? (streamMetrics.blockedReason ?? "blocked") : "first_clip_lost"} played=${streamMetrics.unitsPlayed} dropped=${streamMetrics.unitsDropped}`,
			);
		} else {
			this.cancelStreamSpeak();
		}

		// Invalidate any prior playback before starting a new spoken conclusion.
		this.#speakEpoch += 1;
		this.#bag.abortAll();
		// After a failed/partial stream, speak full plain from sentence 1 — not the
		// 3-sentence tail summary (that skipped "PostgreSQL es…" → "Por ejemplo…").
		const fallbackSource = (streamWasActive || streamDiedBeforeAudio) && fullPlain
			? fullPlain
			: utterance.text;
		this.#pendingSpeakText = maySpeak
			? renderForSpeech(fallbackSource, {
				language: this.#config.engines.language === "auto" ? "es" : this.#config.engines.language,
				mode: this.#config.behavior.speechMode,
				cwd: process.cwd(),
			}).spoken
			: "";
		const willSpeak = Boolean(maySpeak && this.#pendingSpeakText);
		this.dispatch({ type: "AGENT_SETTLED", speak: willSpeak });
		if (!willSpeak) {
			this.scheduleFluentRelisten();
		}
		return {
			speak: willSpeak,
			text: maySpeak ? fallbackSource : "",
			reason: streamBlocked
				? `${utterance.reason}+stream_fallback`
				: utterance.reason,
			streamed: false,
		};
	}

	async #runEffects(effects: readonly VoiceEffect[]): Promise<void> {
		for (const effect of effects) {
			try {
				await this.#runEffect(effect);
			} catch (error) {
				if (isAbortError(error)) continue;
				const message = error instanceof Error ? error.message : String(error);
				this.dispatch({ type: "FAIL", error: message });
			}
		}
	}

	async #runEffect(effect: VoiceEffect): Promise<void> {
		switch (effect.type) {
			case "notify":
				this.deps.notify?.(effect.message, effect.level);
				return;
			case "start_capture": {
				const signal = this.#bag.derive();
				// Echo control: never capture while TTS is active.
				if (this.#state.phase === "speaking" || this.#streamQueue.isBusy) {
					this.deps.notify?.("Capture skipped — TTS playing (echo guard).", "warning");
					return;
				}
				this.#meter.stopPlaybackVisual();
				this.#meter.wave.clear();
				this.#micReady = false;
				this.#incremental.dispose();
				this.#clearProvisional();
				this.#captureGeneration += 1;
				const captureGeneration = this.#captureGeneration;
				this.#activeCaptureGeneration = captureGeneration;
				const captureStartedAtMs = this.#now();
				this.#listenDiag = {
					...this.#listenDiag,
					listenRequestedAtMs: this.#listenDiag.listenRequestedAtMs ?? captureStartedAtMs,
					captureStartedAtMs,
					micReady: false,
					widgetActivityAtListen: "ARMING",
				};
				const vadArmDelayMs = this.#config.behavior.fluentConversation
					? Math.max(0, this.#config.behavior.echoSettleMs)
					: 0;

				if (this.#incrementalWanted()) {
					const lang =
						this.#config.engines.language === "auto" ? "es" : this.#config.engines.language;
					this.#incremental = createIncrementalSttController({
						stt: this.deps.stt,
						language: lang,
						preferPartialProfile: true,
						captureGeneration,
						...(this.deps.now ? { now: this.deps.now } : {}),
						onPartial: (ev) => {
							if (!this.#acceptPartialUi(ev.captureGeneration)) {
								this.#labDiagLine(
									`stt_partial_drop phase=${this.#state.phase} capGen=${ev.captureGeneration} active=${this.#activeCaptureGeneration}`,
								);
								return;
							}
							// Display-only: light lexicon on partials; never submit.
							const shown = this.deps.disableSttCorrections
								? ev.text
								: applySttCorrections(ev.text, this.deps.sttCorrectionRules).corrected;
							this.#provisionalText = shown;
							this.#provisionalKind = "partial";
							this.#labDiagLine(
								`stt_partial capGen=${ev.captureGeneration} gen=${ev.generation} ms=${ev.elapsedMs} bytes=${ev.pcmBytes} chars=${shown.length}`,
							);
							this.deps.onChromeUpdate?.();
						},
						onStatus: (ev) => {
							if (ev.captureGeneration !== this.#activeCaptureGeneration) return;
							if (ev.status === "sealed") {
								this.#provisionalText = "";
								this.#provisionalKind = undefined;
								this.deps.onChromeUpdate?.();
								return;
							}
							if (!this.#acceptPartialUi(ev.captureGeneration) && ev.status !== "stale_cleared") {
								return;
							}
							if (ev.status === "decoding" || ev.status === "stale_cleared") {
								this.#provisionalText = "";
								this.#provisionalKind = ev.status === "decoding" ? "decoding" : undefined;
								this.#labDiagLine(
									`stt_partial_${ev.status} capGen=${ev.captureGeneration} gen=${ev.generation}`
									+ (ev.staleAgeMs !== undefined ? ` ageMs=${ev.staleAgeMs}` : "")
									+ (ev.busyMs !== undefined ? ` busyMs=${ev.busyMs}` : ""),
								);
								this.deps.onChromeUpdate?.();
							} else if (ev.status === "listening") {
								this.#provisionalKind = undefined;
								this.#provisionalText = "";
								this.deps.onChromeUpdate?.();
							}
						},
						onError: (err) => {
							this.#labDiagLine(
								`stt_partial_err ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
							);
						},
					});
				} else {
					this.#incremental = createDisabledIncrementalStt();
				}

				this.#labDiagLine(
					`capture_start capGen=${captureGeneration} armMs=${vadArmDelayMs} inc=${this.#incremental.enabled ? 1 : 0}`,
				);

				const session = await this.deps.capture.start({
					signal,
					vadArmDelayMs,
					onFirstPcm: (info) => {
						this.#micReady = true;
						this.#listenDiag = {
							...this.#listenDiag,
							firstPcmAtMs: info.atMs,
							micReady: true,
							widgetActivityAtListen: "LISTENING",
						};
						this.#labDiagLine(
							`mic_ready cap=${info.captureId.slice(0, 8)} capGen=${captureGeneration} firstPcmMs=${
								info.atMs - (this.#listenDiag.captureStartedAtMs ?? info.atMs)
							}`,
						);
						this.deps.onChromeUpdate?.();
					},
					onSpeechSeen: (info) => {
						this.#incremental.markSpeechSeen();
						this.#labDiagLine(
							`speech_start cap=${info.captureId.slice(0, 8)} capGen=${captureGeneration}`,
						);
					},
					onPcmChunk: (pcm, meta) => {
						// Echo arm: do not feed incremental during settle (TTS bleed → ghosts).
						const elapsed = this.#now() - captureStartedAtMs;
						if (elapsed >= vadArmDelayMs) {
							this.#incremental.pushPcm(pcm);
						}
						if (!this.#config.behavior.visualWaves || this.#state.muted) return;
						this.#meter.pushCapturePcm(pcm, meta.channels);
					},
				});
				this.#captureStop = async () => {
					// Seal BEFORE stop/final STT — kills timer (ghost root cause).
					this.#incremental.seal();
					this.#provisionalText = "";
					this.#provisionalKind = undefined;
					this.deps.onChromeUpdate?.();
					this.#labDiagLine(`capture_end seal capGen=${captureGeneration}`);
					try {
						const audio = await session.stop(signal);
						if (signal.aborted) return;
						if (audio.captureMeta?.speechSeenLatencyMs !== undefined) {
							this.#listenDiag = {
								...this.#listenDiag,
								speechSeenAtMs:
									(this.#listenDiag.captureStartedAtMs ?? 0)
									+ audio.captureMeta.speechSeenLatencyMs,
							};
						}
						this.#micReady = false;
						this.#meter.wave.clear();
						this.dispatch({ type: "CAPTURE_DONE" });
						await this.#transcribe(audio, signal);
					} catch (error) {
						this.#micReady = false;
						this.#meter.wave.clear();
						// Esc / Ctrl+Alt+Space mid-capture or mid-Whisper — never crash Pi.
						if (isAbortError(error) || signal.aborted) {
							this.#labDiagLine("capture_stop_aborted");
							if (this.#state.phase === "listening" || this.#state.phase === "transcribing") {
								this.dispatch({ type: "STOP" });
							}
							return;
						}
						throw error;
					}
				};
				// ARMING until onFirstPcm — do not claim LISTENING yet.
				this.deps.onChromeUpdate?.();
				return;
			}
			case "stop_capture": {
				const stop = this.#captureStop;
				this.#captureStop = undefined;
				if (stop) await stop();
				this.#meter.wave.clear();
				this.deps.onChromeUpdate?.();
				return;
			}
			case "cancel_stt":
			case "cancel_tts":
			case "cancel_playback":
				for (const player of this.#live.values()) void player.stop();
				this.#live.clear();
				this.#pcmTail = Promise.resolve();
				this.#bag.abortAll();
				this.#clearProvisional();
				this.#streamQueue.cancel();
				this.#streamActive = false;
				this.#streamAssembler = undefined;
				this.#streamSignal = undefined;
				this.#meter.stopPlaybackVisual();
				this.deps.onChromeUpdate?.();
				return;
			case "submit_transcript":
				await this.deps.submitTranscript?.(effect.text);
				return;
			case "present_transcript":
				this.#lastTranscript = effect.text;
				this.#pendingReviewText = effect.text;
				await this.deps.presentTranscript?.(effect.text);
				return;
			case "start_tts": {
				const text = this.#pendingSpeakText;
				this.#pendingSpeakText = "";
				const epoch = this.#speakEpoch;
				if (!text || this.#state.muted) {
					this.#meter.stopPlaybackVisual();
					this.dispatch({ type: "SPEAK_DONE" });
					this.deps.onSpeakFinished?.();
					return;
				}
				const signal = this.#bag.derive();
				const stopStagePoll = this.#markTtsChromeStage();
				try {
					this.#lastTtsEngineId = this.deps.tts.id;
					this.#lastTtsFallbackReason = "";
					const audio = await this.#synthesizeForPlayback(
						text,
						signal,
						() => epoch === this.#speakEpoch && !this.#state.muted && !signal.aborted,
					);
					if (epoch !== this.#speakEpoch || this.#state.muted || signal.aborted) {
						const live = this.#live.get(audio);
						if (live) {
							this.#live.delete(audio);
							await live.stop();
						}
						this.#meter.stopPlaybackVisual();
						this.dispatch({ type: "SPEAK_DONE" });
						this.deps.onSpeakFinished?.();
						return;
					}
					// SPEAKING: amplitude from real WAV/PCM window at wall-clock t.
					// pw-play has no byte cursor — position is estimated; samples are real.
					if (await this.#finishLivePlayback(audio, signal)) {
						this.#meter.stopPlaybackVisual();
						this.deps.onChromeUpdate?.();
						if (epoch !== this.#speakEpoch) {
							this.dispatch({ type: "SPEAK_DONE" });
							this.deps.onSpeakFinished?.();
							return;
						}
						this.dispatch({ type: "SPEAK_DONE" });
						this.deps.onSpeakFinished?.();
						return;
					}
					const canScrub =
						audio.format === "wav"
						|| audio.format === "pcm_s16le"
						|| audio.format === "raw";
					this.#simpleSpeakingActivity = !canScrub;
					this.#meter.setSimpleSpeakingActivity(!canScrub);
					this.#meter.beginSpeakingFromAudio(audio);
					void this.#armBargeMonitor();
					this.deps.onChromeUpdate?.();
					const handle = await this.deps.playback.play(audio, { signal });
					await handle.done;
					this.#meter.stopPlaybackVisual();
					this.deps.onChromeUpdate?.();
					if (epoch !== this.#speakEpoch) {
						this.dispatch({ type: "SPEAK_DONE" });
						this.deps.onSpeakFinished?.();
						return;
					}
					this.dispatch({ type: "SPEAK_DONE" });
					this.deps.onSpeakFinished?.();
				} catch (error) {
					this.#meter.stopPlaybackVisual();
					this.deps.onChromeUpdate?.();
					// Cancel during synth/playback must leave phase idle (no orphan "speaking").
					if (error instanceof AbortError || signal.aborted || epoch !== this.#speakEpoch) {
						this.dispatch({ type: "SPEAK_DONE" });
						this.deps.onSpeakFinished?.();
						return;
					}
					// TTS failure: recover fluent loop instead of staying blocked.
					this.dispatch({ type: "SPEAK_DONE" });
					this.deps.onSpeakFinished?.();
					this.deps.notify?.(
						error instanceof Error ? error.message : String(error),
						"error",
					);
					return;
				} finally {
					stopStagePoll();
				}
				return;
			}
			default: {
				const _never: never = effect;
				return _never;
			}
		}
	}

	async #transcribe(audio: AudioChunk, signal: AbortSignal): Promise<void> {
		const language =
			this.#config.engines.language === "auto" ? "es" : this.#config.engines.language;
		const transcriptionId = randomUUID();
		const meta = audio.captureMeta;
		const prompt =
			this.deps.whisperInitialPrompt?.trim() || DEFAULT_WHISPER_INITIAL_PROMPT;
		const t0 = this.#now();
		const incMetrics = this.#incremental.metrics;
		this.#sttTiming = {
			captureEndAtMs: t0,
			silenceHangMsConfigured: this.#config.behavior.silenceMs,
			...(meta?.durationMs !== undefined
				? { captureDurationMs: meta.durationMs }
				: {}),
			...(meta?.speechSeenLatencyMs !== undefined
				? { speechSeenLatencyMs: meta.speechSeenLatencyMs }
				: {}),
			...(incMetrics.firstPartialMs !== undefined
				? { firstPartialMs: incMetrics.firstPartialMs }
				: {}),
			incrementalAttempts: incMetrics.attempts,
			incrementalAccepted: incMetrics.acceptedPartials,
		};

		// P0: no speech validated → do not call Whisper (avoids prompt hallucination on silence).
		if (meta && !meta.speechSeen) {
			this.#clearProvisional();
			this.#lastLabDiag =
				`tx=${transcriptionId.slice(0, 8)} skip_stt=no_speech_seen ${meta.captureId.slice(0, 8)} end=${meta.endReason} durMs=${meta.durationMs}`;
			this.deps.onLabDiag?.(this.#lastLabDiag);
			this.#lastCorrection = undefined;
			this.#pendingReviewText = "";
			this.dispatch({ type: "TRANSCRIBE_EMPTY", detail: formatNoSpeechDetail(meta) });
			if (this.#editHold) {
				this.#resolveEditWaiter("");
				return;
			}
			// A capture that closed on its own never saw speech. Reopening
			// immediately turns a dead microphone into a warning loop.
			// A real silence that reaches maxListen still reopens.
			if (meta.endReason !== "stop") this.scheduleFluentRelisten();
			return;
		}

		const whisperStart = this.#now();
		const epochAtWhisper = this.#speakEpoch;
		this.#sttTiming = { ...this.#sttTiming, whisperStartAtMs: whisperStart };
		// Final path only — never submit a provisional.
		let result: Awaited<ReturnType<SttAdapter["transcribe"]>>;
		try {
			result = await this.deps.stt.transcribe(audio, {
				signal,
				language,
			});
		} catch (error) {
			if (isAbortError(error) || signal.aborted) {
				this.#labDiagLine(`tx=${transcriptionId.slice(0, 8)} whisper_aborted`);
				this.#clearProvisional();
				if (this.#state.phase === "transcribing" || this.#state.phase === "listening") {
					this.dispatch({ type: "STOP" });
				}
				return;
			}
			throw error;
		}
		if (signal.aborted || epochAtWhisper !== this.#speakEpoch) {
			this.#labDiagLine(`tx=${transcriptionId.slice(0, 8)} whisper_stale`);
			this.#clearProvisional();
			this.#pendingReviewText = "";
			if (this.#state.phase === "transcribing" || this.#state.phase === "listening") {
				this.dispatch({ type: "STOP" });
			}
			return;
		}
		const whisperEnd = this.#now();
		this.#sttTiming = {
			...this.#sttTiming,
			whisperEndAtMs: whisperEnd,
			whisperMs: whisperEnd - whisperStart,
		};
		const raw = result.text.trim();
		if (!raw) {
			this.#clearProvisional();
			this.#lastLabDiag =
				`tx=${transcriptionId.slice(0, 8)} whisper_empty silence_ok=1 ${meta ? `cap=${meta.captureId.slice(0, 8)}` : ""} whisperMs=${this.#sttTiming.whisperMs ?? "?"}`;
			this.deps.onLabDiag?.(this.#lastLabDiag);
			this.#lastCorrection = undefined;
			this.#pendingReviewText = "";
			this.dispatch({
				type: "TRANSCRIBE_EMPTY",
				detail: meta
					? `Whisper returned no text. ${formatNoSpeechDetail(meta)}`
					: "Whisper returned no text.",
			});
			if (this.#editHold) {
				this.#resolveEditWaiter("");
				return;
			}
			this.scheduleFluentRelisten();
			return;
		}
		const corrStart = this.#now();
		const correction = this.deps.disableSttCorrections
			? {
				original: raw,
				corrected: raw,
				applied: [] as const,
				changed: false,
			}
			: applySttCorrections(raw, this.deps.sttCorrectionRules);
		this.#lastCorrection = correction;
		const text = correction.corrected;
		// Promote chrome preview to final (still distinct from parcial marker).
		this.#provisionalText = text;
		this.#provisionalKind = "final";
		this.deps.onChromeUpdate?.();
		this.#sttTiming = {
			...this.#sttTiming,
			correctionsMs: this.#now() - corrStart,
		};

		const gateStart = this.#now();
		const gate = gateUtteranceForAutoSubmit({
			text,
			...(meta ? { captureMeta: meta } : {}),
			whisperPrompt: prompt,
		});
		const nowAfterGate = this.#now();
		this.#sttTiming = {
			...this.#sttTiming,
			gateMs: nowAfterGate - gateStart,
			totalPostCaptureMs: nowAfterGate - t0,
		};
		this.#lastLabDiag =
			`tx=${transcriptionId.slice(0, 8)} ${gate.diag} corr=${correction.changed ? 1 : 0} corrMs=${this.#sttTiming.correctionsMs ?? 0} whisperMs=${this.#sttTiming.whisperMs ?? "?"} totalSttMs=${nowAfterGate - t0} silenceCfg=${this.#config.behavior.silenceMs}`;
		this.deps.onLabDiag?.(this.#lastLabDiag);

		// Edit hold: never auto-submit; hand transcript to editor waiter.
		if (this.#editHold) {
			this.#pendingReviewText = text;
			this.#lastTranscript = text;
			this.dispatch({ type: "TRANSCRIBE_REVIEW", text });
			this.#sttTiming = {
				...this.#sttTiming,
				submitAtMs: this.#now(),
				submitted: false,
				totalPostCaptureMs: this.#now() - t0,
			};
			this.#resolveEditWaiter(text);
			return;
		}

		// Dictation never auto-submits — editable review only.
		const wantAuto =
			this.#config.behavior.autoSubmitTranscript
			&& this.#state.mode === "conversation";

		if (!wantAuto) {
			this.#pendingReviewText = text;
			this.dispatch({ type: "TRANSCRIBE_REVIEW", text });
			if (correction.changed) {
				this.deps.notify?.(formatCorrectionDiff(correction), "info");
			}
			return;
		}

		if (!gate.accept) {
			// Unreliable → manual review (or silence), never auto-send.
			this.#pendingReviewText = "";
			if (
				gate.reason === "prompt_echo"
				|| gate.reason === "no_speech_seen"
				|| gate.reason === "rms_too_low"
				|| gate.reason === "voiced_too_short"
				|| gate.reason === "cancelled"
			) {
				this.deps.notify?.(
					`Voice skipped auto-send (${gate.reason}). Silence/noise ignored.`,
					"info",
				);
				this.dispatch({
					type: "TRANSCRIBE_EMPTY",
					detail: meta
						? `Auto-send was blocked (${gate.reason}). ${formatNoSpeechDetail(meta)}`
						: `Auto-send was blocked (${gate.reason}).`,
				});
				this.scheduleFluentRelisten();
				return;
			}
			this.#pendingReviewText = text;
			this.dispatch({ type: "TRANSCRIBE_REVIEW", text });
			this.deps.notify?.(
				`Auto-send blocked (${gate.reason}) — review draft, then /gentle-voice send.`,
				"warning",
			);
			return;
		}

		if (this.#submitOpen && text === this.#lastSubmittedText) {
			this.#lastLabDiag += " anti_dup=hit";
			this.deps.onLabDiag?.(this.#lastLabDiag);
			this.deps.notify?.("Duplicate transcript ignored.", "warning");
			this.#pendingReviewText = "";
			this.dispatch({
				type: "TRANSCRIBE_EMPTY",
				detail: meta
					? `Duplicate transcript ignored. ${formatNoSpeechDetail(meta)}`
					: "Duplicate transcript ignored.",
			});
			if (this.#config.behavior.fluentConversation) this.scheduleFluentRelisten();
			return;
		}

		if (correction.changed && process.env.GENTLE_VOICE_LAB === "1") {
			this.deps.notify?.(
				[
					formatCorrectionDiff(correction),
					`correctionMs=${this.#sttTiming.correctionsMs ?? 0}`,
					"sent=yes",
				].join("\n"),
				"info",
			);
		}

		const turnId = randomUUID();
		this.#lastSubmitTurnId = turnId;
		this.#lastSubmittedText = text;
		this.#lastTranscript = text;
		this.#pendingReviewText = ""; // do not reuse draft on next silence
		this.#submitOpen = true;
		this.cancelVoiceAudio("auto_submit");
		const submitAt = this.#now();
		this.#sttTiming = {
			...this.#sttTiming,
			submitAtMs: submitAt,
			submitted: true,
			totalPostCaptureMs: submitAt - t0,
		};
		this.#lastLabDiag += ` submitTurn=${turnId.slice(0, 8)}`;
		this.deps.onLabDiag?.(this.#lastLabDiag);
		try {
			this.deps.onTranscriptSubmitted?.(text);
		} catch {
			/* never block auto-submit on prewarm hooks */
		}
		this.dispatch({ type: "TRANSCRIBE_DONE", text });
		// Submitted final — drop chrome preview so it cannot be mistaken for a new parcial.
		this.#provisionalText = "";
		this.#provisionalKind = undefined;
		this.deps.onChromeUpdate?.();
	}

	/** End listen window (VAD / user stop) — phase 0 tests call this explicitly. */
	async finishListen(): Promise<void> {
		if (this.#state.phase !== "listening") return;
		const stop = this.#captureStop;
		this.#captureStop = undefined;
		if (!stop) {
			this.dispatch({ type: "STOP" });
			return;
		}
		try {
			await stop();
		} catch (error) {
			if (isAbortError(error)) {
				this.#labDiagLine("finish_listen_aborted");
				return;
			}
			throw error;
		}
	}

	dispose(): void {
		this.cancelScheduledListen();
		this.cancelStreamSpeak();
		this.#clearProvisional();
		this.#incremental.dispose();
		this.#discardBargeMonitor(true);
		this.#bag.abortAll();
		this.#captureStop = undefined;
		this.#submitOpen = false;
		this.#speakEpoch += 1;
		this.#micReady = false;
		this.#meter.dispose();
		this.dispatch({ type: "DISABLE" });
	}
}

export interface FinalSpeakDecision {
	speak: boolean;
	text: string;
	reason: string;
	/** True when incremental stream covered (or will cover) playback. */
	streamed?: boolean;
	/** True while Voice AI inference is in flight (spoken text may differ). */
	narrating?: boolean;
}

export interface SttTimingSnapshot {
	/** Monotonic-ish wall clock from session #now() (Date.now by default). */
	readonly captureEndAtMs?: number;
	readonly captureDurationMs?: number;
	readonly speechSeenLatencyMs?: number;
	readonly silenceHangMsConfigured?: number;
	readonly whisperStartAtMs?: number;
	readonly whisperEndAtMs?: number;
	readonly whisperMs?: number;
	readonly correctionsMs?: number;
	readonly gateMs?: number;
	readonly submitAtMs?: number;
	readonly submitted?: boolean;
	/** End-to-end from capture end → submit (or edit handoff). */
	readonly totalPostCaptureMs?: number;
	/** ms from listen start → first accepted provisional (incremental only). */
	readonly firstPartialMs?: number;
	readonly incrementalAttempts?: number;
	readonly incrementalAccepted?: number;
}

export type VoiceEditPrep =
	| { kind: "current"; text: string }
	| { kind: "last"; text: string }
	| { kind: "empty"; text: string }
	| { kind: "empty_capture"; text: string }
	| { kind: "busy"; text: string };
