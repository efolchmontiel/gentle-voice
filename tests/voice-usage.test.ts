import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createVoiceExtension } from "../extensions/voice.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";
import { ENGINE_SKIP } from "../lib/runtime/onboarding-choice.ts";
import { buildFirstRunPlan, runFirstRunPreparation } from "../lib/runtime/first-run.ts";
import { PREFERRED_SHORTCUT, productShortcutProbeFromEnv } from "../lib/shortcut.ts";
import { initialVoiceState, reduceVoiceState } from "../lib/state-machine.ts";
import {
	USAGE_DICTATION_LABEL,
	appendDictatedText,
	parseUsageChoice,
	parseVoiceUsage,
	readVoiceUsage,
	resolveVoiceUsage,
	usageNeedsSilero,
	usageNeedsSpeechRecognition,
	usageNeedsVoiceEngine,
	voiceUsagePath,
	writeVoiceUsage,
	type VoiceUsage,
} from "../lib/usage/voice-usage.ts";
import { resolveVoiceHomeForTts } from "../lib/vibevoice/tts-preference.ts";
import { VoiceSession } from "../lib/voice-session.ts";

function scratch(): { root: string; env: NodeJS.ProcessEnv; done: () => void } {
	// Not tmpdir(): onboarding refuses to install on tmpfs, which /tmp often is.
	const parent = existsSync(join(homedir(), ".cache")) ? join(homedir(), ".cache") : homedir();
	const root = mkdtempSync(join(parent, "gv-usage-"));
	return {
		root,
		env: {
			HOME: root,
			XDG_DATA_HOME: join(root, "share"),
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_CACHE_HOME: join(root, "cache"),
		},
		done: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("usage parses, persists privately, and the env var wins", () => {
	const { root, done } = scratch();
	try {
		assert.equal(parseVoiceUsage(" Dictation "), "dictation");
		assert.equal(parseVoiceUsage("speak"), undefined);
		assert.equal(readVoiceUsage(root), "conversation");
		writeVoiceUsage(root, "listen");
		assert.equal(readVoiceUsage(root), "listen");
		if (process.platform !== "win32") assert.equal(statSync(voiceUsagePath(root)).mode & 0o777, 0o600);
		assert.equal(resolveVoiceUsage(root, { GENTLE_VOICE_USAGE: "dictation" }), "dictation");
		assert.equal(resolveVoiceUsage(root, { GENTLE_VOICE_USAGE: "nope" }), "listen");
	} finally {
		done();
	}
});

test("each usage needs only its own components", () => {
	const needs = (u: VoiceUsage) => [usageNeedsSpeechRecognition(u), usageNeedsVoiceEngine(u), usageNeedsSilero(u)];
	assert.deepEqual(needs("conversation"), [true, true, true]);
	assert.deepEqual(needs("dictation"), [true, false, false]);
	assert.deepEqual(needs("listen"), [false, true, false]);
	assert.equal(parseUsageChoice(USAGE_DICTATION_LABEL), "dictation");
});

test("dictation appends to what is already typed", () => {
	assert.equal(appendDictatedText("", " hola "), "hola");
	assert.equal(appendDictatedText("revisa esto ", "por favor"), "revisa esto por favor");
	assert.equal(appendDictatedText("intacto", "  "), "intacto");
});

test("listen-only refuses to open the microphone", () => {
	const t = reduceVoiceState(initialVoiceState({ enabled: true, mode: "listen" }), { type: "LISTEN" });
	assert.equal(t.state.phase, "idle");
	assert.equal(t.effects.some((e) => e.type === "start_capture"), false);
	assert.equal(t.effects.some((e) => e.type === "notify" && e.level === "warning"), true);
});

test("the download plan follows the usage", async () => {
	const { env, done } = scratch();
	try {
		const home = resolveVoiceHomeForTts(env);
		writeVoiceUsage(home, "listen");
		const listen = await buildFirstRunPlan(env);
		assert.equal(listen.missing.some((a) => a.kind.startsWith("stt")), false);
		writeVoiceUsage(home, "dictation");
		const dictation = await buildFirstRunPlan(env);
		assert.equal(dictation.missing.some((a) => a.kind.startsWith("tts")), false);
		assert.equal(dictation.missing.some((a) => a.kind.startsWith("stt")), true);
	} finally {
		done();
	}
});

test("a new user who picks dictation is never shown the voice engine menu", async () => {
	const { env, done } = scratch();
	const titles: string[] = [];
	const confirms: string[] = [];
	try {
		await runFirstRunPreparation({
			notify: () => undefined,
			select: async (title, options) => {
				titles.push(title);
				return title === "How do you want to use Gentle Voice?" ? USAGE_DICTATION_LABEL : options[0];
			},
			confirm: async (title) => {
				confirms.push(title);
				return false;
			},
		}, env);
		assert.deepEqual(titles, ["How do you want to use Gentle Voice?"]);
		assert.equal(readVoiceUsage(resolveVoiceHomeForTts(env)), "dictation");
		assert.equal(confirms.includes("Install speech recognition?"), true);
		assert.equal(confirms.includes("Silero VAD"), false);
	} finally {
		done();
	}
});

test("listen-only never offers speech recognition or Silero", async () => {
	const { env, done } = scratch();
	const confirms: string[] = [];
	try {
		writeVoiceUsage(resolveVoiceHomeForTts(env), "listen");
		const titles: string[] = [];
		await runFirstRunPreparation({
			notify: () => undefined,
			select: async (title) => {
				titles.push(title);
				return ENGINE_SKIP;
			},
			confirm: async (title) => {
				confirms.push(title);
				return false;
			},
		}, env);
		assert.equal(titles.includes("How do you want to use Gentle Voice?"), false);
		assert.equal(confirms.includes("Install speech recognition?"), false);
		assert.equal(confirms.includes("Silero VAD"), false);
	} finally {
		done();
	}
});

function dictationSession(mode: "dictation" | "listen" | "conversation"): VoiceSession {
	return new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: false,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				mode,
				fluentConversation: false,
				autoSubmitTranscript: false,
				echoSettleMs: 0,
			},
		},
		capture: createStubCaptureAdapter({
			audio: { bytes: new Uint8Array(64), sampleRateHz: 16_000, channels: 1, format: "pcm_s16le" },
		}),
		stt: createStubSttAdapter({ text: "hola mundo" }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter({ durationMs: 5 }),
	});
}

test("dictation: the shortcut records and the text lands in the editor, unsent", async () => {
	const harness = createPiHostHarness();
	const session = dictationSession("dictation");
	createVoiceExtension(harness.pi, { session, forceStubAdapters: true, shortcutProbe: productShortcutProbeFromEnv({}) });
	await new Promise((r) => setImmediate(r));
	harness.ctx.ui.setEditorText?.("revisa");
	await harness.shortcuts.get(PREFERRED_SHORTCUT)!(harness.ctx);
	assert.equal(session.state.phase, "listening");
	assert.equal(session.config.behavior.fluentConversation, false);
	await harness.shortcuts.get(PREFERRED_SHORTCUT)!(harness.ctx);
	await session.flush();
	assert.equal(harness.ctx.ui.getEditorText?.(), "revisa hola mundo");
	assert.equal(session.pendingReviewText, "");
	assert.equal(session.state.phase, "idle");
});

test("listen: the shortcut keeps the microphone off", async () => {
	const harness = createPiHostHarness();
	const session = dictationSession("listen");
	createVoiceExtension(harness.pi, { session, forceStubAdapters: true, shortcutProbe: productShortcutProbeFromEnv({}) });
	await new Promise((r) => setImmediate(r));
	await harness.shortcuts.get(PREFERRED_SHORTCUT)!(harness.ctx);
	assert.equal(session.state.phase, "idle");
	assert.equal(harness.notifies.some((n) => n.message.startsWith("Listen-only mode")), true);
});

test("/gentle-voice mode switches usage, saves it, and blocks converse outside conversation", async () => {
	const { root, done } = scratch();
	const prev = process.env.GENTLE_VOICE_HOME;
	const prevUsage = process.env.GENTLE_VOICE_USAGE;
	process.env.GENTLE_VOICE_HOME = root;
	delete process.env.GENTLE_VOICE_USAGE;
	try {
		const harness = createPiHostHarness();
		const session = dictationSession("conversation");
		createVoiceExtension(harness.pi, { session, forceStubAdapters: true, shortcutProbe: productShortcutProbeFromEnv({}) });
		await harness.runCommand("gentle-voice", "mode listen");
		assert.equal(session.state.mode, "listen");
		assert.equal(session.state.enabled, true);
		assert.equal(readVoiceUsage(root), "listen");
		await harness.runCommand("gentle-voice", "converse on");
		assert.equal(session.config.behavior.fluentConversation, false);
		assert.equal(harness.notifies.at(-1)?.type, "warning");
		await harness.runCommand("gentle-voice", "mode dictation");
		assert.equal(session.state.mode, "dictation");
		await harness.runCommand("gentle-voice", "mode loud");
		assert.equal(harness.notifies.at(-1)?.message, "Usage: /gentle-voice mode conversation|dictation|listen");
		assert.equal(readVoiceUsage(root), "dictation");
		assert.equal(existsSync(voiceUsagePath(root)), true);
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_HOME;
		else process.env.GENTLE_VOICE_HOME = prev;
		if (prevUsage !== undefined) process.env.GENTLE_VOICE_USAGE = prevUsage;
		done();
	}
});
