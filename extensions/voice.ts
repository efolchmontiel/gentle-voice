/**
 * Pi extension entry — Gentle Voice.
 * Conversation + shortcuts are product features (no LAB required).
 * Lab-only: test-speak / ab-compare / converse-style / voice-ai-profile.
 */

import { randomUUID } from "node:crypto";
import type { VoiceHostApi, VoiceHostCommandContext } from "../lib/contracts.ts";
import {
	applyVoiceAiEnvOverrides,
	DEFAULT_VOICE_CONFIG,
	resolveVoicePaths,
	validateVoiceConfig,
	type VoiceConfig,
} from "../lib/config.ts";
import {
	createModelRegistryHost,
	createVoiceNarrationAdapter,
	formatVoiceAiStatus,
	type NarrationModelHost,
	type VoiceAiRuntimeConfig,
} from "../lib/narration/index.ts";
import { classifyUiPrompt } from "../lib/narration/final-speech-eligibility.ts";
import {
	isGentleVoiceLabMode,
	parseModeFlag,
	parseVoiceArgs,
	VOICE_COMMAND,
	voiceHelpText,
} from "../lib/commands.ts";
import { probeAdapterBundle } from "../lib/adapters/platform.ts";
import { resolveLabVoiceAdapters } from "../lib/adapters/lab-resolve.ts";
import { createVibeVoicePiperBridge } from "../lib/adapters/vibevoice-piper-bridge.ts";
import {
	isVibeVoiceReady,
	probeVibeVoiceReadiness,
	resolveVibeVoiceHome,
	resolveVibeVoiceOnColdStart,
	type VibeVoiceTtsAdapter,
} from "../lib/adapters/vibevoice-tts.ts";
import {
	formatVibeVoiceConsent,
	formatVibeVoiceInstallPlan,
	planVibeVoiceInstall,
	probeVibeVoiceHardware,
} from "../lib/vibevoice/install-plan.ts";
import { readDuplicateVoiceWarning } from "../lib/runtime/duplicate-voice.ts";
import { createNetworkOnboardingIo } from "../lib/vibevoice/network-io.ts";
import { formatInstallView } from "../lib/vibevoice/install-progress.ts";
import {
	describeConversationReadiness,
	planSileroInstall,
} from "../lib/vad/silero-install.ts";
import { formatCapabilities, readCapabilities } from "../lib/runtime/capabilities.ts";
import { driveVibeVoiceInstall } from "../lib/vibevoice/install-drive.ts";
import {
	beginVibeVoiceInstall,
	cancelVibeVoiceInstall,
	commandSkipsInstallWait,
	vibeVoiceInstallSnapshot,
} from "../lib/vibevoice/install-session.ts";
import {
	resolveVoiceHomeForTts,
	writeTtsEnginePreference,
} from "../lib/vibevoice/tts-preference.ts";
import { LAB_TEST_SPEAK_PHRASE } from "../lib/adapters/piper-tts.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import {
	maybeRegisterVoiceShortcut,
	maybeRegisterExtraShortcut,
	type ShortcutProbe,
	defaultVoiceShortcutProbe,
} from "../lib/shortcut.ts";
import { beginSetup } from "../lib/engines/setup.ts";
import type { EngineProbe } from "../lib/engines/detect.ts";
import { createFilesystemEngineProbe } from "../lib/engines/probe-fs.ts";
import { formatCorrectionDiff } from "../lib/stt/corrections.ts";
import { AgentReplyTracker } from "../lib/agent-reply-tracker.ts";
import {
	AB_COMPARE_PHRASES,
	createAbCompareSession,
	formatAbCompareStatus,
	listInstalledTtsSlots,
	piperSlotFromAdapter,
	researchOnlyProviders,
	scoreLastTrial,
	type AbCompareSession,
} from "../lib/tts/ab-compare.ts";
import {
	snapshotVoiceChrome,
	VOICE_STATUS_KEY,
	VOICE_WIDGET_KEY,
} from "../lib/widget-chrome.ts";
import { voiceWidgetContent } from "../lib/visual/compact-widget.ts";
import { runFirstRunPreparation } from "../lib/runtime/first-run.ts";
import { ensureVoiceAiRoles } from "../lib/profiles/voice-ai-role.ts";
import { formatCompatMarkdown } from "../lib/runtime/compat-matrix.ts";
import {
	createEditorHistoryBinding,
	isLoneEscape,
	restorePromptAfterVoiceEscape,
} from "../lib/editor-history.ts";
import {
	formatStorageDiagnostics,
	planGentleVoiceDataCleanup,
	resolveGentleVoiceStorage,
} from "../lib/runtime/storage.ts";
import {
	CLEANUP_CONFIRM_TOKEN,
	executeGentleVoiceDataCleanup,
	formatCleanupPlan,
} from "../lib/runtime/cleanup.ts";
import {
	injectConverseStyleIfEnabled,
	readConverseStyleState,
	resolveVoiceHomeForStyle,
	writeConverseStyleState,
} from "../lib/converse-style.ts";
import {
	readVoiceAiPreference,
	resolveVoiceAiActivation,
	resolveVoiceHomeForPreference,
	writeVoiceAiPreference,
} from "../lib/narration/voice-ai-preference.ts";
import {
	readBargePreference,
	resolveBargeActivation,
	resolveVoiceHomeForBarge,
	writeBargePreference,
} from "../lib/barge-in/preference.ts";
import {
	pipewireFloat32PlaybackSupported,
	readVibeVoicePlaybackPreference,
	resolveVibeVoicePlayback,
	voiceHomeForPlayback,
	writeVibeVoicePlaybackPreference,
	type VibeVoicePlaybackPreference,
} from "../lib/adapters/vibevoice-pcm.ts";
import { createNodeWslAudioIo, driveWslAudioBridge, planWslAudioBridge } from "../lib/adapters/wsl-audio.ts";

export { VOICE_STATUS_KEY, VOICE_WIDGET_KEY };

/**
 * Auto-submit while a conversation session is active.
 * Product default: ON for conversation sessions.
 * Opt-out: GENTLE_VOICE_DISABLE_AUTO_SUBMIT=1.
 * Legacy LAB_AUTO_SUBMIT still forces ON when LAB=1 (compat with older lab docs).
 */
export function conversationAutoSubmitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.GENTLE_VOICE_DISABLE_AUTO_SUBMIT === "1") return false;
	if (env.GENTLE_VOICE_LAB === "1" && env.GENTLE_VOICE_LAB_AUTO_SUBMIT === "1") return true;
	return true;
}

/** @deprecated Use conversationAutoSubmitEnabled — kept for older tests. */
export function labAutoSubmitOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.GENTLE_VOICE_LAB === "1" && env.GENTLE_VOICE_LAB_AUTO_SUBMIT === "1";
}

export interface VoiceExtensionOptions {
	config?: VoiceConfig;
	session?: VoiceSession;
	/** Injected for tests — fail-closed by default (no auto shortcut). */
	shortcutProbe?: ShortcutProbe;
	engineProbe?: EngineProbe;
	/** Force stubs (unit tests). */
	forceStubAdapters?: boolean;
}

function interactive(ctx: VoiceHostCommandContext): boolean {
	return ctx.mode === "tui" && ctx.hasUI;
}

/** Single chrome path — every command/lifecycle hook must use this. */
export function updateChrome(ctx: VoiceHostCommandContext, session: VoiceSession): void {
	if (!interactive(ctx)) return;
	const cols = typeof process.stdout?.columns === "number" ? process.stdout.columns : 80;
	session.setTerminalColumns(cols);
	const chrome = snapshotVoiceChrome(session.state, session.chromeVisual());
	try {
		ctx.ui.setStatus?.(chrome.statusKey, chrome.statusText);
	} catch {
		/* status is cosmetic */
	}
	try {
		// Factory → compact themed leaf (GS customize colors). Avoid string[]
		// full-width Text padding ("huge waybar").
		const content = voiceWidgetContent(chrome.widgetContent, chrome.activity);
		ctx.ui.setWidget?.(chrome.widgetKey, content, { placement: chrome.placement });
	} catch {
		/* widget is cosmetic — fall back to plain lines */
		try {
			ctx.ui.setWidget?.(chrome.widgetKey, chrome.widgetContent, { placement: chrome.placement });
		} catch {
			/* ignore */
		}
	}
}

function applyVoiceAiActivation(session: VoiceSession, fluentConversation: boolean): ReturnType<typeof resolveVoiceAiActivation> {
	const activation = resolveVoiceAiActivation({
		preference: readVoiceAiPreference(resolveVoiceHomeForPreference()),
		fluentConversation,
		env: process.env,
	});
	if (session.config.voiceAi.enabled !== activation.enabled) {
		session.replaceConfig({
			...session.config,
			voiceAi: { ...session.config.voiceAi, enabled: activation.enabled },
		});
	}
	return activation;
}

function bargeActivation(fluentConversation: boolean) {
	return resolveBargeActivation({
		preference: readBargePreference(resolveVoiceHomeForBarge()),
		fluentConversation,
	});
}

/** Start hands-free conversation (product — no LAB required). Mic stays off until LISTEN. */
function enableConversationSession(session: VoiceSession): void {
	const auto = conversationAutoSubmitEnabled();
	session.replaceConfig({
		...session.config,
		enabled: true,
		behavior: {
			...session.config.behavior,
			mode: "conversation",
			fluentConversation: true,
			autoSubmitTranscript: auto,
			silenceMs: Math.min(session.config.behavior.silenceMs, 900),
			vadMaxIntraPauseMs: Math.max(session.config.behavior.vadMaxIntraPauseMs, 500),
		},
	});
	applyVoiceAiActivation(session, true);
	session.dispatch({ type: "ENABLE" });
	session.dispatch({ type: "SET_MODE", mode: "conversation" });
}

function endConversationSession(session: VoiceSession): void {
	session.endEditHold();
	session.cancelVoiceAudio("converse_off");
	session.replaceConfig({
		...session.config,
		behavior: {
			...session.config.behavior,
			fluentConversation: false,
			autoSubmitTranscript: false,
		},
	});
	applyVoiceAiActivation(session, false);
	if (session.state.phase === "listening" || session.state.phase === "speaking" || session.state.phase === "transcribing") {
		session.dispatch({ type: "STOP" });
	}
}

function labDiagEnabled(): boolean {
	return isGentleVoiceLabMode() && process.env.GENTLE_VOICE_LAB_DIAG === "1";
}

/** Capture-aware edit → native Pi editor (no parallel UI). */
async function runVoiceEdit(
	ctx: VoiceHostCommandContext,
	session: VoiceSession,
): Promise<void> {
	if (typeof ctx.ui.setEditorText !== "function") {
		ctx.ui.notify(
			"Pi editor API (setEditorText) unavailable in this host — cannot native-edit.",
			"warning",
		);
		return;
	}

	const prep = await session.prepareVoiceEdit();
	await session.flush();

	if (prep.kind === "busy") {
		ctx.ui.notify(
			"Agent/TTS still active. Press Esc to cancel, then Ctrl+Alt+E again.",
			"warning",
		);
		return;
	}
	if (prep.kind === "empty" || prep.kind === "empty_capture") {
		session.endEditHold();
		ctx.ui.notify(
			prep.kind === "empty_capture"
				? "No speech in the current capture — nothing to edit. Keep speaking, then Ctrl+Alt+E."
				: "No voice transcript to edit yet. Speak a turn first.",
			"warning",
		);
		updateChrome(ctx, session);
		return;
	}

	const existing = (ctx.ui.getEditorText?.() ?? "").trim();
	if (existing && existing !== prep.text.trim()) {
		let overwrite = true;
		const editConfirm = (ctx.ui as unknown as { confirm?: (t: string, m: string) => Promise<boolean> }).confirm;
		if (typeof editConfirm === "function") {
			overwrite = await editConfirm(
				"Gentle Voice Edit",
				"El editor ya tiene texto. ¿Reemplazarlo por la transcripción de voz?",
			);
		}
		if (!overwrite) {
			session.endEditHold();
			ctx.ui.notify("Edit cancelled — editor unchanged.", "info");
			updateChrome(ctx, session);
			return;
		}
	}

	ctx.ui.setEditorText(prep.text);
	const note = prep.kind === "current"
		? "Gentle Voice Edit: current utterance is in the Pi editor (auto-send paused). Fix it and press Enter to send as a new message."
		: "Gentle Voice Edit: loaded LAST sent voice line (no newer capture). Enter re-sends as a new message — history is not rewritten.";
	ctx.ui.notify(note, "info");
	updateChrome(ctx, session);
}

/**
 * Esc cancels Gentle Voice only. It does not call ctx.abort().
 * Returning `{ consume: true }` stops Pi from treating the same key as
 * app.interrupt. A second Esc, once voice is idle, is not consumed, so Pi
 * can still interrupt the orchestrator.
 */
function handleVoiceEscape(
	ctx: VoiceHostCommandContext,
	session: VoiceSession,
): { consume: true } | void {
	const phase = session.state.phase;
	const busy =
		phase === "listening"
		|| phase === "speaking"
		|| phase === "transcribing"
		|| phase === "awaiting_agent"
		|| session.streamActive
		|| session.editHold;
	if (!session.state.enabled || !busy) return;

	const recoverable = [
		session.pendingReviewText,
		session.lastSubmittedText,
		session.lastTranscript,
	];

	session.cancelVoiceAudio("escape");
	if (session.editHold) session.endEditHold();

	restorePromptAfterVoiceEscape(ctx, recoverable);
	updateChrome(ctx, session);
	return { consume: true };
}

function voiceAiRuntimeFromConfig(config: VoiceConfig): VoiceAiRuntimeConfig {
	return {
		enabled: config.voiceAi.enabled,
		role: config.voiceAi.role,
		onError: config.voiceAi.onError,
		style: config.voiceAi.style,
		timeoutMs: config.voiceAi.timeoutMs,
		maxInputChars: config.voiceAi.maxInputChars,
		preferredProfile: process.env.GENTLE_VOICE_AI_HOST_PROFILE?.trim() || undefined,
	};
}

export function createVoiceExtension(pi: VoiceHostApi, options: VoiceExtensionOptions = {}): VoiceSession {
	const config = applyVoiceAiEnvOverrides(options.config ?? {
		...DEFAULT_VOICE_CONFIG,
		engines: { ...DEFAULT_VOICE_CONFIG.engines, language: "es" },
		behavior: { ...DEFAULT_VOICE_CONFIG.behavior, autoSubmitTranscript: false },
		voiceAi: { ...DEFAULT_VOICE_CONFIG.voiceAi },
	});
	// Product default: real adapters. node:test sets NODE_TEST_CONTEXT → stubs unless forced.
	const underNodeTest = Boolean(process.env.NODE_TEST_CONTEXT);
	const useRealAudio = options.forceStubAdapters === true
		? false
		: options.forceStubAdapters === false
			? true
			: options.session
				? false
				: underNodeTest
					? false
					: true;

	const replyTracker = new AgentReplyTracker();
	const editorHistory = createEditorHistoryBinding();
	let vadFinish: (() => void) | undefined;
	let abSession: AbCompareSession | undefined;
	let firstRunDone = false;
	let firstRunPromise: Promise<void> | undefined;

	const attachVad = () => {
		vadFinish = () => {
			// Must swallow AbortError — Space/Esc aborting mid-Whisper used to crash Pi
			// with uncaughtException (throwIfAborted in whisper-stt).
			void session.finishListen()
				.then(() => {
					if (lastCtx) updateChrome(lastCtx, session);
				})
				.catch((error) => {
					if (error && typeof error === "object" && (error as { name?: string }).name === "AbortError") {
						if (lastCtx) updateChrome(lastCtx, session);
						return;
					}
					try {
						lastCtx?.ui.notify(
							`Voice listen end failed: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					} catch {
						/* ignore */
					}
				});
		};
	};

	let session: VoiceSession;
	let lastCtx: VoiceHostCommandContext | undefined;

	let lastVadStatus = "unknown";
	const notifyVadBackend = (info: { backend: string; fallbackReason?: string }) => {
		lastVadStatus = info.fallbackReason ? `${info.backend}/${info.fallbackReason}` : info.backend;
		if (!info.fallbackReason) return;
		const msg = info.fallbackReason === "silero_model_path_missing"
			? "VAD: energy. Silero model is not installed. Energy fallback is active."
			: `VAD: ${info.backend} (fallback: ${info.fallbackReason})`;
		try {
			lastCtx?.ui.notify(msg, "warning");
		} catch {
			/* host may not be ready */
		}
	};

	let resolved = resolveLabVoiceAdapters({
		config,
		forceStub: !useRealAudio,
		onVadEnd: () => {
			vadFinish?.();
		},
		onVadResolved: notifyVadBackend,
	});
	let adapters = resolved.bundle;

	const prewarmVibeVoiceIfSelected = () => {
		// Opt-in only: CUDA load at attach starves Silero/Whisper. Prefer submit-time warm.
		if (process.env.GENTLE_VOICE_VIBEVOICE_PREWARM !== "1") return;
		const vv = resolved.vibevoiceAdapter as
			| { prewarm?: () => Promise<void> }
			| undefined;
		if (!vv?.prewarm) return;
		const activeId = session?.deps?.tts?.id;
		if (activeId !== "vibevoice" && resolved.ttsKind !== "vibevoice") return;
		void vv.prewarm().catch(() => {
			/* prewarm is best-effort; first speak still cold-starts */
		});
	};

	const rebindAdaptersFromRuntime = () => {
		if (!useRealAudio) return;
		resolved = resolveLabVoiceAdapters({
			config: session.config,
			forceStub: false,
			onVadEnd: () => {
				vadFinish?.();
			},
			onVadResolved: notifyVadBackend,
		});
		adapters = resolved.bundle;
		session.deps.capture = adapters.capture;
		session.deps.stt = adapters.stt;
		session.deps.tts = adapters.tts;
		session.deps.playback = adapters.playback;
		prewarmVibeVoiceIfSelected();
	};

	const preparationHost = (ctx: VoiceHostCommandContext) => {
		const ui = ctx.ui as unknown as {
			confirm?: (title: string, message: string) => Promise<boolean>;
			select?: (title: string, options: string[]) => Promise<string | undefined>;
			setStatus?: (key: string, text: string | undefined) => void;
			setWidget?: (key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
		};
		return {
			notify: (message: string, level?: "info" | "warning" | "error") => {
				try {
					ctx.ui.notify(message, level ?? "info");
				} catch {
					/* ignore */
				}
			},
			...(typeof ui.confirm === "function"
				? { confirm: (title: string, message: string) => ui.confirm!(title, message) }
				: {}),
			...(typeof ui.select === "function"
				? { select: (title: string, options: readonly string[]) => ui.select!(title, [...options]) }
				: {}),
			...(typeof ui.setStatus === "function"
				? { setStatus: (key: string, text: string | undefined) => ui.setStatus!(key, text) }
				: {}),
			...(typeof ui.setWidget === "function"
				? {
					setWidget: (key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) =>
						ui.setWidget!(key, content, options),
				}
				: {}),
			captureReady: async () => {
				if ((await adapters.capture.availability()).status !== "ready") return false;
				if (!useRealAudio || process.platform !== "linux") return true;
				// On WSL, pw-record alone records nothing until PipeWire reaches WSLg.
				const wsl = await planWslAudioBridge(process.env, createNodeWslAudioIo());
				return wsl.kind === "not-wsl" || wsl.kind === "ready";
			},
			...(useRealAudio && process.platform === "linux"
				? {
					prepareCapture: async () => {
						await driveWslAudioBridge({
							notify: (message, level) => {
								try {
									ctx.ui.notify(message, level ?? "info");
								} catch {
									/* ignore */
								}
							},
							...(typeof ui.confirm === "function"
								? { confirm: (title: string, message: string) => ui.confirm!(title, message) }
								: {}),
						});
					},
				}
				: {}),
			activateEngine: async () => {
				rebindAdaptersFromRuntime();
				const tts = session.deps.tts as {
					id?: string;
					setNotify?: (fn: (message: string, level?: "info" | "warning" | "error") => void) => void;
				};
				tts.setNotify?.((message, level) => {
					session.deps.notify?.(message, level ?? "info");
				});
				return {
					ttsId: tts.id,
					sttKind: resolved.sttKind,
					pcmSupported: pipewireFloat32PlaybackSupported(),
				};
			},
		};
	};

	const ensureAutomaticFirstRun = (ctx: VoiceHostCommandContext): Promise<void> => {
		if (!useRealAudio || options.session) return Promise.resolve();
		if (firstRunDone) return Promise.resolve();
		if (firstRunPromise) return firstRunPromise;
		firstRunPromise = (async () => {
			const snap = await runFirstRunPreparation(preparationHost(ctx));
			firstRunDone = true;
			if (snap.status === "ready" || snap.status === "partial") {
				rebindAdaptersFromRuntime();
			}
		})().catch((error) => {
			firstRunDone = true;
			try {
				ctx.ui.notify(
					`Gentle Voice setup failed: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			} catch {
				/* ignore */
			}
		});
		return firstRunPromise;
	};

	let narrationHost: NarrationModelHost | undefined;
	const narrationAdapter = createVoiceNarrationAdapter({
		config: voiceAiRuntimeFromConfig(config),
		// session is assigned just below; fall back to bootstrap config during init.
		getConfig: () =>
			voiceAiRuntimeFromConfig(session?.config ?? config),
		getHost: () => narrationHost,
		hostKind: () => resolveGentleVoiceStorage().hostKind,
		onNotice: (message) => {
			try {
				lastCtx?.ui.notify(message, "info");
			} catch {
				/* ignore */
			}
		},
	});

	session = options.session ?? new VoiceSession({
		config,
		capture: adapters.capture,
		stt: adapters.stt,
		tts: adapters.tts,
		playback: adapters.playback,
		narrationAdapter,
		sessionId: () => {
			try {
				return lastCtx?.sessionManager?.getSessionId?.()
					?? (lastCtx?.sessionManager as { sessionId?: string } | undefined)?.sessionId;
			} catch {
				return undefined;
			}
		},
		activeModel: () => {
			const m = lastCtx?.model as { provider?: string; id?: string } | undefined;
			if (!m?.id) return undefined;
			return { id: m.id, ...(m.provider ? { provider: m.provider } : {}) };
		},
		activeThinking: () => lastCtx?.thinkingLevel,
		bargeInEnabled: () => bargeActivation(session.config.behavior.fluentConversation).enabled,
		submitTranscript: (text) => {
			replyTracker.markVoiceSubmit(randomUUID());
			pi.sendUserMessage?.(text);
		},
		presentTranscript: (text) => {
			void text;
		},
		notify: () => {},
		onSpeakFinished: () => {
			// Muted: still re-listen. Echo settle lives inside scheduleFluentRelisten.
			session.scheduleFluentRelisten();
		},
		onTranscriptSubmitted: () => {
			// Overlap VV CUDA load with agent LLM — keeps first speak off the critical path.
			const tts = session.deps.tts as { prewarm?: () => Promise<void>; id?: string };
			if (tts.id === "vibevoice" && typeof tts.prewarm === "function") {
				void tts.prewarm().catch(() => {});
			}
		},
		onChromeUpdate: () => {
			if (lastCtx) updateChrome(lastCtx, session);
		},
		whisperInitialPrompt: process.env.GENTLE_VOICE_WHISPER_PROMPT?.trim()
			|| undefined,
		onLabDiag: (line) => {
			if (process.env.GENTLE_VOICE_LAB_DIAG === "1" && lastCtx) {
				try {
					lastCtx.ui.notify(`voice-diag: ${line}`, "info");
				} catch {
					/* ignore */
				}
			}
		},
	});

	const bindNarrationHost = (ctx: VoiceHostCommandContext | undefined): void => {
		if (!ctx?.modelRegistry) return;
		const registryHost = createModelRegistryHost(ctx.modelRegistry);
		if (!registryHost) return;
		// Registry miss falls back to the live context model, read at call time
		// so a Pi model switch is not stuck on the model from session start.
		narrationHost = {
			find: (provider, modelId) => {
				const found = registryHost.find(provider, modelId);
				if (found) return found;
				const live = lastCtx?.model;
				if (!live?.id || live.id !== modelId) return undefined;
				if (provider && live.provider && live.provider !== provider) return undefined;
				return live;
			},
			hasConfiguredAuth: registryHost.hasConfiguredAuth,
			complete: (model, context, options) => registryHost.complete(model, context, options),
		};
	};
	attachVad();
	applyVoiceAiActivation(session, session.config.behavior.fluentConversation);
	prewarmVibeVoiceIfSelected();
	// Injected sessions (tests) still need live chrome refresh during PCM/TTS.
	session.deps.onChromeUpdate = () => {
		if (lastCtx) updateChrome(lastCtx, session);
	};
	session.deps.notify = (message, level) => {
		try {
			lastCtx?.ui.notify(message, level);
		} catch {
			/* ignore */
		}
	};
	const bridgeTts = session.deps.tts as {
		setNotify?: (fn: (message: string, level?: "info" | "warning" | "error") => void) => void;
	};
	bridgeTts.setNotify?.((message, level) => {
		session.deps.notify?.(message, level ?? "info");
	});
	session.deps.presentTranscript = async (text) => {
		if (!lastCtx) return;
		const corr = session.lastCorrection;
		const head = corr?.changed
			? formatCorrectionDiff(corr)
			: `🎙 Transcript (review — not sent):\n${text}`;
		lastCtx.ui.notify(
			[head, "", "Edit: /gentle:voice draft <texto>\nSend: /gentle:voice send"].join("\n"),
			"info",
		);
	};
	session.deps.submitTranscript = async (text) => {
		session.endEditHold();
		// Correlate this voice turn with turn_end/agent_end — agent_settled has no message.
		replyTracker.markVoiceSubmit(randomUUID());
		// Extension sendUserMessage skips Pi's Enter → addToHistory; push so Up works.
		editorHistory.tryBind(lastCtx);
		editorHistory.push(text);
		pi.sendUserMessage?.(text);
		// Fluent: one short line (no review spam). Dictation/manual still quiet.
		if (lastCtx && !session.config.behavior.fluentConversation) {
			lastCtx.ui.notify(`Voice transcript queued (${text.length} chars).`, "info");
		}
	};

	const shortcutProbe = options.shortcutProbe ?? defaultVoiceShortcutProbe();
	let spaceShortcutRegistered = false;
	let editShortcutRegistered = false;
	let spaceShortcutReason = "pending";
	let editShortcutReason = "pending";

	void maybeRegisterVoiceShortcut(pi, {
		...(session.config.behavior.shortcut
			? { configuredShortcut: session.config.behavior.shortcut }
			: {}),
		probe: shortcutProbe,
		handler: async (ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			await ensureAutomaticFirstRun(lastCtx);
			const fluent = session.config.behavior.fluentConversation;

			// ——— Conversation session toggle (product hands-free) ———
			if (!session.state.enabled || !fluent) {
				enableConversationSession(session);
				session.dispatch({ type: "LISTEN" });
				await session.flush();
				lastCtx.ui.notify(
					`Conversation ON (autoSubmit=${session.config.behavior.autoSubmitTranscript}). Speak; VAD ends turns. Ctrl+Alt+Space ends.`,
					"info",
				);
				updateChrome(lastCtx, session);
				return;
			}

			if (fluent) {
				// Cancel audio first; do not block Space on long TTS teardown.
				if (session.state.phase === "awaiting_agent") {
					endConversationSession(session);
					void session.flush();
					lastCtx.ui.notify("Conversation ended — agent continues; mic/TTS stopped.", "info");
					updateChrome(lastCtx, session);
					return;
				}
				endConversationSession(session);
				void session.flush();
				lastCtx.ui.notify("Conversation OFF.", "info");
				updateChrome(lastCtx, session);
				return;
			}

			if (session.state.phase === "speaking") {
				session.cancelVoiceAudio("shortcut_stop");
				await session.flush();
				updateChrome(lastCtx, session);
				return;
			}
			if (session.state.phase === "awaiting_agent") {
				lastCtx.ui.notify("Agent still working — wait before a new listen.", "warning");
				return;
			}
			if (!session.state.enabled) {
				session.dispatch({ type: "ENABLE" });
				session.dispatch({ type: "LISTEN" });
				await session.flush();
				updateChrome(lastCtx, session);
				return;
			}
			if (session.state.phase === "listening") {
				await session.finishListen();
			} else {
				session.dispatch({ type: "LISTEN" });
			}
			await session.flush();
			updateChrome(lastCtx, session);
		},
	}).then((availability) => {
		spaceShortcutRegistered = availability.registered;
		spaceShortcutReason = availability.reason;
	});

	// Ctrl+Alt+E — edit pending / last voice transcript (same product probe as Space).
	void maybeRegisterExtraShortcut(pi, {
		chord: "ctrl+alt+e",
		description: "Gentle Voice Edit — pending / last voice transcript in Pi editor",
		probe: shortcutProbe,
		handler: async (ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			await runVoiceEdit(lastCtx, session);
		},
	}).then((result) => {
		editShortcutRegistered = result.registered;
		editShortcutReason = result.reason;
	});

	// Esc coordination via raw terminal input — only when voice is busy.
	// Does not register a global Esc shortcut (preserves menus/editor when idle).
	// Arrow keys are CSI (\x1b[A) — must NOT be treated as Esc (isLoneEscape).
	const attachEscape = (ctx: VoiceHostCommandContext) => {
		editorHistory.tryBind(ctx);
		if (typeof ctx.ui.onTerminalInput !== "function") return;
		if ((attachEscape as { done?: boolean }).done) return;
		(attachEscape as { done?: boolean }).done = true;
		ctx.ui.onTerminalInput((data) => {
			if (!isLoneEscape(data)) return;
			if (!lastCtx) lastCtx = ctx;
			return handleVoiceEscape(lastCtx, session);
		});
	};

	pi.registerCommand(VOICE_COMMAND, {
		description: "Local voice session (Gentle Voice)",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			attachEscape(ctx);
			const parsed = parseVoiceArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			if (parsed.command === "vibevoice-setup" && parsed.rest.trim() === "cancel") {
				ctx.ui.notify(
					cancelVibeVoiceInstall() ? "Installation cancelled." : "No VibeVoice installation is running.",
					"warning",
				);
				return;
			}
			const installNow = vibeVoiceInstallSnapshot();
			if (installNow.running && parsed.command === "vibevoice-setup" && parsed.rest.trim() !== "plan") {
				ctx.ui.notify(
					`${installNow.message}\nVibeVoice installation is already running. /gentle:voice vibevoice-setup cancel stops it.`,
					"info",
				);
				return;
			}
			if (!commandSkipsInstallWait(parsed.command, parsed.rest)) {
				await ensureAutomaticFirstRun(ctx);
			}

			if (parsed.command === "edit") {
				await runVoiceEdit(ctx, session);
				return;
			}

			if (parsed.command === "stream") {
				const voiceHome = voiceHomeForPlayback();
				const arg = parsed.rest.trim().toLowerCase();
				const choice = resolveVibeVoicePlayback({
					env: process.env,
					preference: readVibeVoicePlaybackPreference(voiceHome),
					pcmSupported: pipewireFloat32PlaybackSupported(),
				});
				if (arg === "" || arg === "status") {
					ctx.ui.notify(
						[
							"Gentle Voice — VibeVoice playback",
							`Preference    ${choice.preference}`,
							`Active        ${choice.mode} (${choice.source})`,
							choice.fallbackReason
								? "PCM unsupported on this host; using WAV for VibeVoice."
								: "PCM is the default when pw-play supports float32.",
							"WAV: /gentle:voice stream wav",
							"PCM: /gentle:voice stream pcm   auto: /gentle:voice stream auto",
							"This process: GENTLE_VOICE_VIBEVOICE_NATIVE_STREAM=0 forces WAV (overrides the file).",
							"Does not change Piper vs VibeVoice. Engine: /gentle:voice tts (lab) or GENTLE_VOICE_TTS.",
						].join("\n"),
						"info",
					);
					return;
				}
				if (arg !== "auto" && arg !== "pcm" && arg !== "wav") {
					ctx.ui.notify("Usage: /gentle:voice stream auto|pcm|wav|status", "warning");
					return;
				}
				writeVibeVoicePlaybackPreference(voiceHome, arg as VibeVoicePlaybackPreference);
				const next = resolveVibeVoicePlayback({
					env: process.env,
					preference: arg as VibeVoicePlaybackPreference,
					pcmSupported: pipewireFloat32PlaybackSupported(),
				});
				ctx.ui.notify(
					next.fallbackReason
						? `Saved ${arg}. This host cannot play float32 PCM, so VibeVoice stays on WAV.`
						: `VibeVoice playback ${next.mode} (${next.source}). Piper is unchanged.`,
					"info",
				);
				return;
			}

			if (parsed.labCommand === "converse-style") {
				if (!isGentleVoiceLabMode()) {
					ctx.ui.notify("Unknown subcommand \"converse-style\".", "warning");
					return;
				}
				const voiceHome = resolveVoiceHomeForStyle();
				const arg = parsed.rest.trim().toLowerCase();
				if (arg === "status" || arg === "") {
					const st = readConverseStyleState(voiceHome);
					ctx.ui.notify(
						[
							`converse-style=${st.enabled ? "on" : "off"}`,
							`updatedAt=${st.updatedAt}`,
							"Does NOT change model — use /gentle:profiles for voice-ai (MiMo).",
							"When on: injects session style via before_agent_start (1 LLM/turn).",
						].join("\n"),
						"info",
					);
					return;
				}
				const on = arg === "on" || arg === "1" || arg === "true";
				const off = arg === "off" || arg === "0" || arg === "false";
				if (!on && !off) {
					ctx.ui.notify("Usage: /gentle:voice converse-style on|off|status", "warning");
					return;
				}
				const st = writeConverseStyleState(voiceHome, on);
				ctx.ui.notify(
					on
						? "converse-style ON — next agent turns use conversational Spanish (same model). Model unchanged."
						: "converse-style OFF — habitual agent style restored. History kept. Model unchanged.",
					"info",
				);
				if (labDiagEnabled()) {
					ctx.ui.notify(`voice-diag: converse-style=${st.enabled} at=${st.updatedAt}`, "info");
				}
				return;
			}

			if (parsed.command === "add") {
				const arg = parsed.rest.trim().toLowerCase();
				if (arg !== "voice-ai") {
					ctx.ui.notify("Usage: /gentle:voice add voice-ai", "warning");
					return;
				}
				let result: ReturnType<typeof ensureVoiceAiRoles>;
				try {
					result = ensureVoiceAiRoles();
				} catch (error) {
					ctx.ui.notify(
						`voice-ai role was not added: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
					return;
				}
				if (result.status === "missing") {
					ctx.ui.notify(
						[
							result.agentCreated
								? `voice-ai is now listed in /gentle:models (${result.agentPath}).`
								: `voice-ai agent file: ${result.agentPath}.`,
							`No profiles file at ${result.path}. Create a profile with /gentle:profiles, then run /gentle:voice add voice-ai.`,
						].join("\n"),
						"warning",
					);
					return;
				}
				if (result.status === "invalid") {
					ctx.ui.notify(`profiles.json at ${result.path} was not changed (${result.reason ?? "invalid"}).`, "warning");
					return;
				}
				if (result.status === "unchanged") {
					ctx.ui.notify(
						"voice-ai is on every profile and in /gentle:models. Set the model and effort there, then save.",
						"info",
					);
					return;
				}
				ctx.ui.notify(
					[
						result.added.length > 0
							? `Added an empty voice-ai role to ${result.added.join(", ")}.`
							: "voice-ai now matches the model saved in /gentle:models.",
						"Open /gentle:models, choose voice-ai, and save the model and effort.",
					].join("\n"),
					"info",
				);
				return;
			}

			if (parsed.command === "voice-ai") {
				bindNarrationHost(ctx);
				const arg = parsed.rest.trim().toLowerCase();
				if (arg === "status" || arg === "") {
					const d = session.narrationDiagnostics() ?? narrationAdapter.lastDiagnostics();
					const activation = applyVoiceAiActivation(
						session,
						session.config.behavior.fluentConversation,
					);
					const thinking = session.deps.activeThinking?.() as
						| import("../lib/narration/types.ts").NarrationThinkingLevel
						| undefined;
					const res = narrationAdapter.inspectNarrator({
						sessionId: session.deps.sessionId?.(),
						activeModel: session.deps.activeModel?.(),
						activeThinking: thinking,
					});
					const liveOrch = ctx.model
						? `${ctx.model.provider ? `${ctx.model.provider}/` : ""}${ctx.model.id ?? "?"}`
						: "(unknown)";
					const profileOrch =
						"orchestratorRef" in res && res.orchestratorRef
							? res.orchestratorRef
							: liveOrch;
					const timing = session.lastVoiceTiming();
					ctx.ui.notify(
						formatVoiceAiStatus({
							hostKind: resolveGentleVoiceStorage().hostKind,
							enabled: activation.enabled,
							activationSource: activation.source,
							streaming: session.config.voiceAi.streaming,
							resolution: res,
							orchestratorLabel: profileOrch,
							diagnostics: d,
							...(timing.narrationMs !== undefined ? { narrationMs: timing.narrationMs } : {}),
							...(timing.synthToPlaybackMs !== undefined
								? { synthToPlaybackMs: timing.synthToPlaybackMs }
								: {}),
						}),
						"info",
					);
					return;
				}
				const on = arg === "on" || arg === "1" || arg === "true";
				const off = arg === "off" || arg === "0" || arg === "false";
				if (!on && !off) {
					ctx.ui.notify("Usage: /gentle:voice voice-ai on|off|status", "warning");
					return;
				}
				writeVoiceAiPreference(resolveVoiceHomeForPreference(), on ? "on" : "off");
				applyVoiceAiActivation(session, session.config.behavior.fluentConversation);
				ctx.ui.notify(
					on
						? "Voice AI ON — after the final reply, a second call prepares the narration. The written text stays."
						: "Voice AI OFF — Speech Renderer + Streaming TTS of orchestrator text (no second LLM).",
					"info",
				);
				return;
			}

			if (parsed.command === "barge-in") {
				const arg = parsed.rest.trim().toLowerCase();
				if (arg === "status" || arg === "") {
					const activation = bargeActivation(session.config.behavior.fluentConversation);
					const trace = session.bargeTrace();
					ctx.ui.notify(
						[
							"Gentle Voice — barge-in",
							`Enabled       ${activation.enabled ? "on" : "off"}`,
							`Activation    ${activation.source}`,
							`Preference    ${activation.preference}`,
							"Scope         playback while phase=speaking (not during tools)",
							"Echo          mic-floor gate, not AEC",
							"Orchestrator  not aborted",
							"Esc           still cancels audio",
							...(trace.length > 0 ? ["Trace:"] : []),
							...trace,
						].join("\n"),
						"info",
					);
					return;
				}
				const on = arg === "on" || arg === "1" || arg === "true";
				const off = arg === "off" || arg === "0" || arg === "false";
				if (!on && !off) {
					ctx.ui.notify("Usage: /gentle:voice barge-in on|off|status", "warning");
					return;
				}
				writeBargePreference(resolveVoiceHomeForBarge(), on ? "on" : "off");
				const activation = bargeActivation(session.config.behavior.fluentConversation);
				ctx.ui.notify(
					on
						? `Barge-in explicit on (${activation.source}). El monitor solo abre el mic mientras hay reproducción. No es cancelación de eco.`
						: "Barge-in explicit off. Ctrl+Alt+Space y converse on no lo vuelven a encender.",
					"info",
				);
				return;
			}

			if (parsed.labCommand === "voice-ai-profile") {
				if (!isGentleVoiceLabMode()) {
					ctx.ui.notify("Unknown subcommand \"voice-ai-profile\".", "warning");
					return;
				}
				const lab = await import("../lib/lab/voice-ai-profile.ts").catch(() => undefined);
				if (!lab) {
					ctx.ui.notify("voice-ai-profile is a lab helper and is not in this package.", "warning");
					return;
				}
				const result = lab.ensureVoiceAiProfile();
				if (result.refused) {
					ctx.ui.notify(`voice-ai-profile refused: ${result.reason}`, "warning");
					return;
				}
				ctx.ui.notify(
					[
						`host=${result.hostProfile}`,
						`role=${lab.VOICE_AI_ROLE_NAME}`,
						`model=${result.model}`,
						`thinking=${result.thinking}`,
						`path=${result.path}`,
						`created=${result.created} updated=${result.updated} removedTopLevel=${result.removedTopLevelProfile}`,
						"voice-ai is a ROLE under OpenSource → Profile routing (like review-risk).",
						"Primary chat still uses OpenSource orchestrator. Voice AI uses this role for TTS narration only.",
					].join("\n"),
					"info",
				);
				return;
			}

			if (parsed.labCommand === "test-speak") {
				if (!isGentleVoiceLabMode()) {
					ctx.ui.notify("Unknown subcommand \"test-speak\".", "warning");
					return;
				}
				if (!session.state.enabled) {
					session.dispatch({ type: "ENABLE" });
					await session.flush();
				}
				const phrase = parsed.rest.trim() || LAB_TEST_SPEAK_PHRASE;
				if (session.state.muted) {
					ctx.ui.notify("Muted — TTS skipped (mic/STT still work).", "warning");
					updateChrome(ctx, session);
					return;
				}
				const outcome = await session.speakDirect(phrase);
				if (outcome === "muted") {
					ctx.ui.notify("Muted — TTS skipped (mic/STT still work).", "warning");
				} else if (outcome === "disabled") {
					ctx.ui.notify("Voice is off. Use /gentle:voice on first.", "warning");
				} else if (outcome === "played") {
					ctx.ui.notify("test-speak: done.", "info");
				} else if (outcome === "empty") {
					ctx.ui.notify("test-speak: empty phrase.", "warning");
				}
				await session.flush();
				updateChrome(ctx, session);
				return;
			}

			if (parsed.command === "vibevoice-setup") {
				const targetDir = resolveVibeVoiceHome();
				const voiceHome = resolveVoiceHomeForTts();
				const hardware = probeVibeVoiceHardware(targetDir);
				const alreadyInstalled = isVibeVoiceReady();
				const plan = planVibeVoiceInstall({
					targetDir,
					hardware,
					alreadyInstalled,
					allowTmpfs: process.env.GENTLE_VOICE_VIBEVOICE_ALLOW_TMPFS === "1",
				});
				if (parsed.rest.trim() === "plan") {
					const phase = vibeVoiceInstallSnapshot();
					const prefix = phase.running ? `${phase.message}\n\n` : "";
					ctx.ui.notify(`${prefix}${formatVibeVoiceInstallPlan(plan)}`, plan.status === "blocked" ? "warning" : "info");
					return;
				}
				if (vibeVoiceInstallSnapshot().running) {
					ctx.ui.notify(vibeVoiceInstallSnapshot().message, "info");
					return;
				}
				const uiConfirm = (ctx.ui as unknown as { confirm?: (t: string, m: string) => Promise<boolean> }).confirm;
				let consent: boolean | undefined;
				if (alreadyInstalled) consent = true;
				else if (plan.status === "blocked") consent = false;
				else if (typeof uiConfirm === "function") {
					consent = await uiConfirm("Install VibeVoice?", formatVibeVoiceConsent(plan));
				}
				const networkLock = process.env.GENTLE_VOICE_VIBEVOICE_ALLOW_NETWORK;
				const allowNetwork = networkLock === "0" ? false : consent === true || networkLock === "1";
				if (consent === true && allowNetwork) {
					await driveVibeVoiceInstall(preparationHost(ctx), {
						targetDir,
						voiceHome,
						hardware,
						alreadyInstalled,
						consent,
						allowNetwork,
						allowTmpfs: process.env.GENTLE_VOICE_VIBEVOICE_ALLOW_TMPFS === "1",
						io: createNetworkOnboardingIo(),
					});
					return;
				}
				const result = await beginVibeVoiceInstall({
					targetDir,
					voiceHome,
					hardware,
					alreadyInstalled,
					consent,
					allowNetwork,
					allowTmpfs: process.env.GENTLE_VOICE_VIBEVOICE_ALLOW_TMPFS === "1",
				});
				ctx.ui.notify(
					result.status === "cancelled" ? "Installation cancelled." : result.reason,
					"warning",
				);
				return;
			}

			if (parsed.command === "tts") {
				const eng = parsed.rest.trim().toLowerCase();
				if (eng !== "piper" && eng !== "kokoro" && eng !== "vibevoice") {
					ctx.ui.notify(
						`Usage: /gentle:voice tts piper|kokoro|vibevoice\nactive=${resolved.ttsKind} kokoroReady=${resolved.kokoroReady} vibevoiceReady=${resolved.vibevoiceReady}`,
						"warning",
					);
					return;
				}
				if (eng === "kokoro") {
					if (!resolved.kokoroAdapter) {
						ctx.ui.notify(
							"Kokoro unavailable (lab OFF or not installed). Product default is Piper. Set GENTLE_VOICE_LAB=1 only in a dedicated lab.",
							"warning",
						);
						return;
					}
					session.deps.tts = resolved.kokoroAdapter;
					ctx.ui.notify(
						"TTS engine → kokoro (session). Applies to agent spoken replies and test-speak. Default install remains Piper until you switch.",
						"info",
					);
				} else if (eng === "vibevoice") {
					if (!resolved.vibevoiceAdapter) {
						ctx.ui.notify(
							`VibeVoice unavailable (${probeVibeVoiceReadiness().reason}). Piper still works. Set GENTLE_VOICE_VIBEVOICE_HOME to an engine directory you installed yourself. See docs/vibevoice-tts.md.`,
							"warning",
						);
						return;
					}
					writeTtsEnginePreference(resolveVoiceHomeForTts(), "vibevoice");
					if (
						resolveVibeVoiceOnColdStart() === "piper"
						&& resolved.piperAdapter
					) {
						session.deps.tts = createVibeVoicePiperBridge({
							vibevoice: resolved.vibevoiceAdapter as VibeVoiceTtsAdapter,
							piper: resolved.piperAdapter,
							notify: (m, l) => ctx.ui.notify(m, l ?? "info"),
						});
						ctx.ui.notify(
							"TTS → vibevoice (lab). onColdStart=piper: Piper en frío, VV después.",
							"info",
						);
					} else {
						session.deps.tts = resolved.vibevoiceAdapter;
						ctx.ui.notify(
							"TTS → vibevoice. PCM when pw-play supports float32. Voice sp-Spk0_woman.",
							"info",
						);
					}
				} else {
					if (!resolved.piperAdapter) {
						ctx.ui.notify("Piper not available.", "warning");
						return;
					}
					const vv = resolved.vibevoiceAdapter as { dispose?: () => Promise<void> } | undefined;
					void vv?.dispose?.();
					session.deps.tts = resolved.piperAdapter;
					writeTtsEnginePreference(resolveVoiceHomeForTts(), "piper");
					ctx.ui.notify("TTS engine → piper. VibeVoice worker stopped (VRAM freed).", "info");
				}
				updateChrome(ctx, session);
				return;
			}

			if (parsed.labCommand === "ab-compare") {
				if (!isGentleVoiceLabMode()) {
					ctx.ui.notify("Unknown subcommand \"ab-compare\".", "warning");
					return;
				}
				const tokens = parsed.rest.trim().split(/\s+/).filter(Boolean);
				let phraseIndex = 0;
				let engineHint = "";
				for (const tok of tokens) {
					if (/^\d+$/.test(tok)) phraseIndex = Number.parseInt(tok, 10);
					else engineHint = tok.toLowerCase();
				}
				if (!Number.isInteger(phraseIndex) || phraseIndex < 0 || phraseIndex >= AB_COMPARE_PHRASES.length) {
					ctx.ui.notify(
						`Usage: /gentle:voice ab-compare [0-${AB_COMPARE_PHRASES.length - 1}] [piper|kokoro|vibevoice]\nPhrases:\n${
							AB_COMPARE_PHRASES.map((p, i) => `  ${i}: ${p}`).join("\n")
						}`,
						"warning",
					);
					return;
				}
				if (engineHint === "kokoro" || engineHint === "piper" || engineHint === "vibevoice") {
					if (engineHint === "kokoro" && resolved.kokoroAdapter) session.deps.tts = resolved.kokoroAdapter;
					else if (engineHint === "vibevoice" && resolved.vibevoiceAdapter) {
						session.deps.tts = resolved.vibevoiceAdapter;
					} else if (engineHint === "piper" && resolved.piperAdapter) {
						session.deps.tts = resolved.piperAdapter;
					} else {
						ctx.ui.notify(`Engine "${engineHint}" not installed.`, "warning");
						return;
					}
				}
				const candidateSlots = [];
				if (resolved.piperAdapter) {
					candidateSlots.push(piperSlotFromAdapter(resolved.piperAdapter, {
						id: "piper-es-AR-daniela-high",
						notes: resolved.piperVoice ?? "lab piper",
					}));
				}
				if (resolved.kokoroAdapter) {
					candidateSlots.push({
						info: {
							id: "kokoro-ef-dora",
							displayName: "Kokoro-82M ef_dora (ES)",
							engine: "kokoro" as const,
							platforms: ["linux", "win32", "darwin"] as const,
							verifiedLocally: true,
							licenseHint: "Apache-2.0",
							notes: "Lab Kokoro ONNX (env-configured paths) + ef_dora only",
						},
						adapter: resolved.kokoroAdapter,
					});
				}
				if (resolved.vibevoiceAdapter) {
					candidateSlots.push({
						info: {
							id: "vibevoice-sp-Spk0_woman",
							displayName: "VibeVoice Realtime 0.5B sp-Spk0_woman (ES experimental)",
							engine: "vibevoice" as const,
							platforms: ["linux"] as const,
							verifiedLocally: true,
							licenseHint: "MIT (research)",
							notes: "Keep-alive worker. PCM when float32 playback works; WAV on request.",
						},
						adapter: resolved.vibevoiceAdapter,
					});
				}
				const installed = await listInstalledTtsSlots(candidateSlots);
				if (installed.length === 0) {
					ctx.ui.notify("No installed TTS ready for A/B.", "warning");
					return;
				}
				const activeId = session.deps.tts.id.includes("vibevoice")
					? "vibevoice-sp-Spk0_woman"
					: session.deps.tts.id.includes("kokoro")
						? "kokoro-ef-dora"
						: "piper-es-AR-daniela-high";
				const slot = installed.find((s) => s.info.id === activeId) ?? installed[0]!;
				if (!abSession) {
					abSession = createAbCompareSession(installed, slot.info.id);
				}
				const research = researchOnlyProviders(new Set(installed.map((s) => s.info.id)));
				const phrase = AB_COMPARE_PHRASES[phraseIndex]!;
				if (session.state.muted) {
					ctx.ui.notify("Muted — A/B playback skipped.", "warning");
					return;
				}
				if (!session.state.enabled) {
					session.dispatch({ type: "ENABLE" });
					await session.flush();
				}
				const prevTts = session.deps.tts;
				session.deps.tts = slot.adapter;
				const t0 = performance.now();
				const outcome = await session.speakDirect(phrase);
				const synthesizeMs = Math.round(performance.now() - t0);
				session.deps.tts = prevTts;
				const trial = {
					phraseIndex,
					phrase,
					providerId: slot.info.id,
					displayName: slot.info.displayName,
					synthesizeMs,
					audioBytes: 0,
					sampleRateHz: slot.info.engine === "piper" ? 22_050 : 24_000,
					...(outcome !== "played" ? { error: outcome } : {}),
				};
				abSession = {
					...abSession,
					activeProviderId: slot.info.id,
					trials: [...abSession.trials, trial],
				};
				ctx.ui.notify(
					[
						formatAbCompareStatus(abSession),
						"",
						`Played #${phraseIndex} via ${trial.providerId} (${trial.synthesizeMs}ms wall).`,
						`Rate: /gentle:voice ab-score ${phraseIndex} <1-5>`,
						`Installed: ${installed.map((s) => s.info.id).join(", ")}`,
						research.length
							? `Not selectable: ${research.map((r) => r.id).join(", ")}`
							: "",
					].filter(Boolean).join("\n"),
					"info",
				);
				await session.flush();
				updateChrome(ctx, session);
				return;
			}

			if (parsed.labCommand === "ab-score") {
				if (!isGentleVoiceLabMode()) {
					ctx.ui.notify("Unknown subcommand \"ab-score\".", "warning");
					return;
				}
				if (!abSession || abSession.trials.length === 0) {
					ctx.ui.notify("No A/B trials yet. Run /gentle:voice ab-compare first.", "warning");
					return;
				}
				const parts = parsed.rest.trim().split(/\s+/);
				let phraseIndex: number;
				let score: number;
				if (parts.length === 1) {
					phraseIndex = abSession.trials[abSession.trials.length - 1]!.phraseIndex;
					score = Number.parseInt(parts[0]!, 10);
				} else {
					phraseIndex = Number.parseInt(parts[0]!, 10);
					score = Number.parseInt(parts[1]!, 10);
				}
				const last = [...abSession.trials]
					.reverse()
					.find((t) => t.phraseIndex === phraseIndex);
				if (!last) {
					ctx.ui.notify(`No trial for phrase #${phraseIndex}.`, "warning");
					return;
				}
				try {
					abSession = scoreLastTrial(abSession, last.providerId, phraseIndex, score);
					ctx.ui.notify(formatAbCompareStatus(abSession), "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				}
				return;
			}

			switch (parsed.command) {
				case "": {
					if (!session.state.enabled) {
						session.dispatch({ type: "ENABLE" });
					} else if (session.state.phase === "idle") {
						ctx.ui.notify(session.statusLine(), "info");
					} else {
						session.dispatch({ type: "STOP" });
					}
					break;
				}
				case "on": {
					const mode = parseModeFlag(parsed.rest);
					if (mode) session.dispatch({ type: "SET_MODE", mode });
					session.dispatch({ type: "ENABLE" });
					break;
				}
				case "off":
					session.dispatch({ type: "DISABLE" });
					break;
				case "listen":
					session.dispatch({ type: "LISTEN" });
					break;
				case "stop":
					if (session.state.phase === "listening") await session.finishListen();
					else session.dispatch({ type: "STOP" });
					break;
				case "mute":
					if (parsed.rest.trim().toLowerCase() === "off") session.dispatch({ type: "UNMUTE" });
					else session.dispatch({ type: "MUTE" });
					break;
				case "draft": {
					const draft = parsed.rest.trim();
					if (!draft) {
						ctx.ui.notify(
							session.pendingReviewText
								? `Current draft:\n${session.pendingReviewText}`
								: "No pending draft. Listen first or: /gentle:voice draft <text>",
							"info",
						);
						break;
					}
					session.setReviewDraft(draft);
					ctx.ui.notify(`Draft updated (not sent):\n${draft}`, "info");
					break;
				}
				case "send": {
					const outcome = await session.submitPending(parsed.rest.trim() || undefined);
					if (outcome === "sent") {
						ctx.ui.notify("Transcript sent to agent.", "info");
					} else if (outcome === "empty") {
						ctx.ui.notify("Nothing to send (empty transcript).", "warning");
					} else if (outcome === "duplicate") {
						ctx.ui.notify("Already sent — waiting for the agent.", "warning");
					} else if (outcome === "busy") {
						ctx.ui.notify("Busy — wait for the agent/TTS to finish.", "warning");
					} else if (outcome === "disabled") {
						ctx.ui.notify("Voice is off. Use /gentle:voice on first.", "warning");
					}
					break;
				}
				case "converse": {
					const arg = parsed.rest.trim().toLowerCase();
					const on = arg === "on" || arg === "1" || arg === "true";
					const off = arg === "off" || arg === "0" || arg === "false";
					if (!arg) {
						ctx.ui.notify(
							`Conversation is ${session.config.behavior.fluentConversation ? "ON" : "OFF"}.`,
							"info",
						);
						break;
					}
					if (!on && !off) {
						ctx.ui.notify("Usage: /gentle:voice converse on|off", "warning");
						break;
					}
					if (on) {
						enableConversationSession(session);
						session.dispatch({ type: "LISTEN" });
					} else {
						endConversationSession(session);
					}
					const silero = on ? await planSileroInstall() : undefined;
					const degraded = silero && silero.status !== "ready"
						? " Silero is not active, so conversation uses the energy fallback."
						: "";
					ctx.ui.notify(
						on
							? `Conversation ON (autoSubmit=${session.config.behavior.autoSubmitTranscript}). VAD ends utterances. Ctrl+Alt+Space ends session.${degraded}`
							: "Conversation OFF — dictation/manual listen/stop/send.",
						silero && silero.status !== "ready" ? "warning" : "info",
					);
					break;
				}
				case "purge": {
					const storage = resolveGentleVoiceStorage();
					const rest = parsed.rest.trim();
					const keepModels = /(?:^|\s)--keep-models(?:\s|$)/.test(rest);
					const plan = planGentleVoiceDataCleanup(storage, { keepModels });
					const confirmMatch = rest.match(/--confirm(?:=|\s+)(\S+)/);
					const confirm = confirmMatch?.[1] ?? "";
					if (!confirm) {
						ctx.ui.notify(
							[
								formatCleanupPlan(plan),
								"",
								"This does NOT uninstall the npm package.",
								"To delete private data after reviewing paths:",
								`  /gentle:voice purge --confirm ${CLEANUP_CONFIRM_TOKEN}`,
								`  /gentle:voice purge --keep-models --confirm ${CLEANUP_CONFIRM_TOKEN}`,
								"Or after package removal: `npx --package gentle-voice gentle-voice-cleanup [--keep-models] --confirm …`",
								"Never deletes Voxtype / WD-Black / other Pi packages / GS versions.",
							].join("\n"),
							"info",
						);
						break;
					}
					const result = await executeGentleVoiceDataCleanup({
						confirm,
						resolution: storage,
						keepModels,
					});
					ctx.ui.notify(
						[
							`purge.ok=${result.ok}`,
							`purge.keepModels=${keepModels}`,
							...result.deleted.map((d) => `deleted=${d}`),
							...result.skipped.map((d) => `skipped=${d}`),
							...result.errors.map((e) => `error=${e}`),
						].join("\n"),
						result.ok ? "info" : "warning",
					);
					break;
				}
				case "status": {
					const install = vibeVoiceInstallSnapshot();
					const probe = await probeAdapterBundle(adapters);
					const setup = await beginSetup({
						probe: options.engineProbe ?? createFilesystemEngineProbe(),
					});
					const storage = resolveGentleVoiceStorage();
					const selected = session.config.engines.tts || "(auto)";
					const activeId = session.deps.tts.id;
					const lastSynth = session.lastTtsEngineId;
					const conversationCapable =
						probe.capture === "ready"
						&& probe.stt === "ready"
						&& probe.tts === "ready"
						&& probe.playback === "ready";
					const sileroPlan = await planSileroInstall();
					const capabilities = readCapabilities();
					const nd = session.narrationDiagnostics() ?? narrationAdapter.lastDiagnostics();
					const narratorNow = narrationAdapter.inspectNarrator({
						sessionId: session.deps.sessionId?.(),
						activeModel: session.deps.activeModel?.(),
						activeThinking: session.deps.activeThinking?.() as
							| import("../lib/narration/types.ts").NarrationThinkingLevel
							| undefined,
					});
					const lines = [
						install.running ? `vibevoice.install=${install.phase} ${install.message}` : "vibevoice.install=idle",
						...(install.steps.length > 0 ? formatInstallView(install.steps) : []),
						session.statusLine(),
						`hostKind=${storage.hostKind}`,
						`storageRoot=${storage.storageRoot}`,
						`platform=${probe.platform}`,
						`engines.capture=${probe.capture}`,
						`engines.stt=${probe.stt}`,
						`engines.tts=${probe.tts}`,
						`engines.playback=${probe.playback}`,
						`conversationCapable=${conversationCapable}`,
						...describeConversationReadiness({
							tts: probe.tts,
							stt: probe.stt,
							capture: probe.capture,
							playback: probe.playback,
							silero: sileroPlan.status,
							vadBackend: lastVadStatus,
						}),
						...(capabilities ? formatCapabilities(capabilities) : []),
						`conversationActive=${session.config.behavior.fluentConversation}`,
						`mode=${session.config.behavior.mode}`,
						`autoSubmitEffective=${session.config.behavior.autoSubmitTranscript}`,
						`autoSubmitDisabledEnv=${process.env.GENTLE_VOICE_DISABLE_AUTO_SUBMIT === "1"}`,
						`voiceAi.enabled=${session.config.voiceAi.enabled}`,
						`voiceAi.role=${session.config.voiceAi.role}`,
						`voiceAi.streaming=${session.config.voiceAi.streaming}`,
						`voiceAi.narrator=${nd.narratorRef ?? "(none yet)"}`,
						`voiceAi.source=${nd.narratorSource ?? "(none)"}`,
						`voiceAi.profileOrigin=${("profileOrigin" in narratorNow && narratorNow.profileOrigin) || "(none)"}`,
						`voiceAi.note=${("note" in narratorNow && narratorNow.note) || "(none)"}`,
						`vad=${lastVadStatus}`,
						`voiceAi.lastPath=${nd.lastPath ?? "(none)"}`,
						`tts.selected=${selected}`,
						`tts.activeAdapter=${activeId}`,
						`tts.lastSynthesize=${lastSynth}`,
						`tts.fallbackReason=${session.lastTtsFallbackReason || "(none)"}`,
						`tts.voiceHint=${
							activeId.includes("vibevoice")
								? "vibevoice/sp-Spk0_woman"
								: activeId.includes("kokoro")
									? "kokoro/ef_dora"
									: activeId.includes("piper")
										? "piper/daniela-high"
										: activeId
						}`,
						`kokoroLabReady=${resolved.kokoroReady}`,
						`vibevoiceReady=${resolved.vibevoiceReady}`,
						`engines.scenario=${setup.report.scenario}`,
						`shortcut.space.registered=${spaceShortcutRegistered}`,
						`shortcut.space.reason=${spaceShortcutReason}`,
						`shortcut.edit.registered=${editShortcutRegistered}`,
						`shortcut.edit.reason=${editShortcutReason}`,
						`shortcut.disabledEnv=${process.env.GENTLE_VOICE_DISABLE_SHORTCUTS === "1"}`,
						`shortcut.osDelivery=unknown (registration ≠ physical key reception)`,
						`lastSubmitTurn=${session.lastSubmitTurnId || "(none)"}`,
						`pendingDraft=${session.pendingReviewText ? "yes" : "no"}`,
						"",
						voiceHelpText({ includeLab: isGentleVoiceLabMode() }),
					];
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}
				case "config": {
					const paths = resolveVoicePaths(session.config);
					const storage = resolveGentleVoiceStorage();
					const validation = validateVoiceConfig(session.config);
					ctx.ui.notify([
						`schema=${session.config.schema}`,
						`enabled=${session.config.enabled}`,
						`mode=${session.config.behavior.mode}`,
						`muted=${session.config.behavior.muted}`,
						`shortcut=${session.config.behavior.shortcut ?? "(none — preferred Ctrl+Alt+Space only if verified)"}`,
						`engines.stt=${session.config.engines.stt || "(auto)"}`,
						`engines.tts=${session.config.engines.tts || "(auto)"}`,
						`hostKind=${storage.hostKind}`,
						`paths.home=${paths.home}`,
						`paths.models=${paths.models}`,
						`paths.cache=${paths.cache}`,
						`paths.tmp=${paths.tmp}`,
						`paths.configFile=${paths.configFile}`,
						`overrides=${storage.activeOverrides.length ? storage.activeOverrides.join(",") : "(none)"}`,
						`validation=${validation.ok ? "ok" : validation.errors.join("; ")}`,
						"",
						`behavior.autoSubmitTranscript=${session.config.behavior.autoSubmitTranscript}`,
						`pendingDraft=${session.pendingReviewText ? "yes" : "no"}`,
						"Overrides: GENTLE_VOICE_HOME|MODELS|CACHE|TMP|CONFIG",
					].join("\n"), "info");
					break;
				}
				case "storage": {
					const storage = resolveGentleVoiceStorage();
					const plan = planGentleVoiceDataCleanup(storage);
					ctx.ui.notify(
						[
							formatStorageDiagnostics(storage),
							"",
							"Cleanup dry-run (no delete):",
							`allowed=${plan.allowed}`,
							...plan.directories.map((d) => `  - ${d}`),
							plan.reasonsDenied.length
								? `denied: ${plan.reasonsDenied.join("; ")}`
								: plan.note,
							"",
							"Package uninstall: `pi remove npm:gentle-voice` or `gentle-shell remove npm:gentle-voice`.",
							"Data cleanup is manual/optional — never automatic.",
						].join("\n"),
						"info",
					);
					break;
				}
				case "setup": {
					const snap = await runFirstRunPreparation(preparationHost(ctx));
					ctx.ui.notify(
						[
							`setup.status=${snap.status}`,
							`setup.platform=${snap.platform}/${snap.arch}`,
							`setup.home=${snap.layoutHome}`,
							`setup.present=${snap.present.join(",") || "(none)"}`,
							`setup.missing=${snap.missing.join(",") || "(none)"}`,
							`setup.estBytes=${snap.estimatedDownloadBytes}`,
							snap.message,
							"",
							"Compat (honest):",
							formatCompatMarkdown(),
						].join("\n"),
						"info",
					);
					break;
				}
				default:
					ctx.ui.notify(voiceHelpText({ includeLab: isGentleVoiceLabMode() }), "info");
			}

			await session.flush();
			updateChrome(ctx, session);
		},
	});

	// Pi 1.2 lifecycle: message lives on turn_end / agent_end; agent_settled is {aborted} only.
	// Streaming: message_update.assistantMessageEvent.text_delta (confirmed in Pi/GS protocol).
	if (typeof pi.on === "function") {
		// Conversational style: same model, appendSystemPrompt only (no second LLM).
		pi.on("before_agent_start", (event) => {
			if (!isGentleVoiceLabMode()) return;
			const voiceHome = resolveVoiceHomeForStyle();
			const enabled = readConverseStyleState(voiceHome).enabled;
			const opts = (event as { systemPromptOptions?: { appendSystemPrompt?: string } | null })
				?.systemPromptOptions;
			injectConverseStyleIfEnabled(opts ?? undefined, enabled);
		});
		// First-run on host session start — no mandatory /gentle:voice setup.
		pi.on("session_start", (_event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			bindNarrationHost(lastCtx);
			attachEscape(lastCtx);
			const duplicate = readDuplicateVoiceWarning();
			if (duplicate) lastCtx.ui.notify(duplicate, "warning");
			try {
				ensureVoiceAiRoles();
			} catch {
				/* a profiles write must not block the voice session */
			}
			void ensureAutomaticFirstRun(lastCtx);
			updateChrome(lastCtx, session);
		});
		pi.on("agent_start", (_event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			bindNarrationHost(lastCtx);
			attachEscape(lastCtx);
			void ensureAutomaticFirstRun(lastCtx);
			if (!session.state.enabled) return;
			// Edit → Enter uses native Pi send; correlate so spoken reply still works.
			if (session.editHold) {
				session.endEditHold();
				replyTracker.markVoiceSubmit(randomUUID());
			}
			session.dispatch({ type: "AGENT_STARTED" });
			session.beginStreamSpeak();
			updateChrome(lastCtx, session);
		});
		pi.on("message_update", (event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			if (!session.state.enabled) return;
			session.onMessageUpdate(event);
			updateChrome(lastCtx, session);
		});
		pi.on("turn_end", (event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			replyTracker.onTurnEnd(event);
		});
		pi.on("agent_end", (event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			replyTracker.onAgentEnd(event);
		});
		pi.on("agent_before_settle", (event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			replyTracker.onBeforeSettle(event);
		});
		pi.on("agent_settled", (event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			bindNarrationHost(lastCtx);
			if (!session.state.enabled) return;
			const aborted = Boolean((event as { aborted?: boolean })?.aborted);
			const entries = lastCtx.sessionManager?.getEntries?.();
			const plan = replyTracker.consumeSettled({
				aborted,
				...(entries ? { sessionEntries: entries } : {}),
			});
			if (labDiagEnabled() && plan.skipReason && lastCtx) {
				lastCtx.ui.notify(
					`voice-diag: settle skip=${plan.skipReason} source=${plan.source}`,
					"warning",
				);
			}
			if (plan.skipReason === "duplicate_fingerprint" || plan.skipReason === "aborted") {
				session.cancelVoiceAudio("settle_skip");
				session.onAgentSettled({ message: null, outcome: plan.outcome });
				void session.flush().then(() => updateChrome(lastCtx!, session));
				return;
			}
			if (plan.skipReason === "no_assistant_message" || plan.skipReason === "not_awaiting_voice_turn") {
				session.cancelVoiceAudio("settle_skip");
				session.onAgentSettled({ message: null, outcome: plan.outcome });
				void session.flush().then(() => updateChrome(lastCtx!, session));
				return;
			}
			const decision = session.onAgentSettled({
				message: plan.message,
				outcome: plan.outcome,
			});
			// P4: never duplicate the spoken reply as a notify — widget SPEAKING only.
			if (decision.reason === "unfaithful_skip_show_full") {
				/* notify already emitted inside onAgentSettled */
			} else if (labDiagEnabled() && lastCtx) {
				lastCtx.ui.notify(
					`voice-diag: speak=${decision.speak} streamed=${Boolean(decision.streamed)} reason=${decision.reason}`,
					"info",
				);
			}
			void session.flush().then(() => updateChrome(lastCtx!, session));
		});
		pi.on("ui_prompt_start", (event) => {
			const decision = classifyUiPrompt(event);
			if (!decision.speak || !session.config.behavior.fluentConversation) return;
			void session.playSideNotice(decision.text);
		});
		pi.on("session_shutdown", () => {
			session.dispose();
			const vv = resolved.vibevoiceAdapter as { dispose?: () => Promise<void> } | undefined;
			void vv?.dispose?.();
		});
	}

	return session;
}

/** Pi package default export. */
export default function gentleVoice(pi: VoiceHostApi): void {
	createVoiceExtension(pi);
}
