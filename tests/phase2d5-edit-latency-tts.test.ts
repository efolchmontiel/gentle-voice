/**
 * Phase 2D.5 — capture-aware edit, Strategy B grouping, STT timing snapshot.
 * No LLM tokens / no network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import { createVoiceExtension } from "../extensions/voice.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { SentenceAssembler } from "../lib/tts/sentence-assembler.ts";
import { allowlistShortcutProbe } from "../lib/shortcut.ts";

function convoConfig(overrides: Partial<typeof DEFAULT_VOICE_CONFIG.behavior> = {}) {
	return {
		...DEFAULT_VOICE_CONFIG,
		enabled: true,
		behavior: {
			...DEFAULT_VOICE_CONFIG.behavior,
			mode: "conversation" as const,
			fluentConversation: true,
			autoSubmitTranscript: true,
			echoSettleMs: 0,
			muted: false,
			...overrides,
		},
	};
}

test("2D.5 assembler Strategy B: groups two short sentences", () => {
	const a = new SentenceAssembler({
		language: "es",
		minSentencesPerUnit: 2,
		minCharsPerUnit: 140,
	});
	assert.deepEqual(a.pushDelta("Uno corto. "), []);
	const u = a.pushDelta("Dos también corto.");
	assert.equal(u.length, 1);
	assert.match(u[0]!.speakable, /Uno/);
	assert.match(u[0]!.speakable, /Dos/);
});

test("2D.5 assembler Strategy B: long sentence flushes alone", () => {
	const long =
		"Esta es una oración bastante larga para superar el umbral de caracteres largos y salir sola. ";
	assert.ok(long.trim().length >= 80);
	const a = new SentenceAssembler({
		language: "es",
		minSentencesPerUnit: 2,
		minCharsPerUnit: 140,
		longSentenceChars: 80,
	});
	const u = a.pushDelta(long);
	assert.equal(u.length, 1);
	assert.match(u[0]!.speakable, /bastante larga/);
});

test("2D.5 edit during LISTENING prefers current capture over lastSubmitted", async () => {
	const harness = createPiHostHarness();
	const session = new VoiceSession({
		config: convoConfig({ autoSubmitTranscript: false }),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "frase actual del usuario" }),
		tts: createStubTtsAdapter({ latencyMs: 1 }),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
	});
	createVoiceExtension(harness.pi, {
		session,
		forceStubAdapters: true,
		shortcutProbe: allowlistShortcutProbe(["ctrl+alt+space", "ctrl+alt+e"]),
	});
	session.dispatch({ type: "ENABLE" });

	await session.submitPending("Ok, muchas gracias. Te pasaste");
	assert.equal(session.lastSubmittedText, "Ok, muchas gracias. Te pasaste");
	session.dispatch({ type: "STOP" });
	await session.flush();

	session.dispatch({ type: "LISTEN" });
	await session.flush();
	assert.equal(session.state.phase, "listening");

	const prep = await session.prepareVoiceEdit();
	assert.equal(prep.kind, "current");
	assert.equal(prep.text, "frase actual del usuario");
	assert.equal(session.editHold, true);
	assert.notEqual(prep.text, session.lastSubmittedText);
});

test("2D.5 edit hold blocks auto-submit of late STT", async () => {
	const submitted: string[] = [];
	const session = new VoiceSession({
		config: convoConfig({ autoSubmitTranscript: true }),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "no debe autoenviarse" }),
		tts: createStubTtsAdapter({ latencyMs: 1 }),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
		submitTranscript: async (text) => {
			submitted.push(text);
		},
	});
	session.dispatch({ type: "ENABLE" });
	session.dispatch({ type: "LISTEN" });
	await session.flush();

	const prep = await session.prepareVoiceEdit();
	assert.equal(prep.kind, "current");
	assert.equal(prep.text, "no debe autoenviarse");
	await session.flush();
	assert.equal(submitted.length, 0, "editHold must block auto-submit");
	assert.equal(session.sttTiming.submitted, false);
});

test("2D.5 edit without new capture returns last with resend semantics", async () => {
	const harness = createPiHostHarness();
	const session = new VoiceSession({
		config: convoConfig({ autoSubmitTranscript: false }),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: createStubTtsAdapter({ latencyMs: 1 }),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
	});
	createVoiceExtension(harness.pi, {
		session,
		forceStubAdapters: true,
		shortcutProbe: allowlistShortcutProbe(["ctrl+alt+e"]),
	});
	session.dispatch({ type: "ENABLE" });
	await session.submitPending("mensaje previo");
	session.dispatch({ type: "STOP" });
	await session.flush();

	await harness.runCommand("gentle-voice", "edit");
	assert.equal(session.editHold, true);
	assert.equal(harness.ctx.ui.getEditorText?.(), "mensaje previo");
	assert.ok(harness.notifies.some((n) => /LAST sent/i.test(n.message)));
});

test("2D.5 silence / empty capture does not invent an utterance", async () => {
	const session = new VoiceSession({
		config: convoConfig(),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "" }),
		tts: createStubTtsAdapter({ latencyMs: 1 }),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
	});
	session.dispatch({ type: "ENABLE" });
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	const prep = await session.prepareVoiceEdit();
	assert.equal(prep.kind, "empty_capture");
	assert.equal(prep.text, "");
});

test("2D.5 STT timing snapshot records whisper + submit flags", async () => {
	const session = new VoiceSession({
		config: convoConfig({ autoSubmitTranscript: true }),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "hola timing", latencyMs: 5 }),
		tts: createStubTtsAdapter({ latencyMs: 1 }),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
		submitTranscript: async () => {},
	});
	session.dispatch({ type: "ENABLE" });
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	const t = session.sttTiming;
	assert.ok(typeof t.captureEndAtMs === "number");
	assert.ok(typeof t.whisperStartAtMs === "number");
	assert.ok(typeof t.whisperEndAtMs === "number");
	assert.ok(typeof t.whisperMs === "number" && t.whisperMs >= 0);
	assert.equal(t.submitted, true);
	assert.ok(typeof t.submitAtMs === "number");
});

test("2D.5 edit does not overwrite editor without confirm refusal path", async () => {
	const harness = createPiHostHarness();
	harness.ctx.ui.setEditorText?.("texto previo del usuario");
	let confirmCalls = 0;
	(harness.ctx.ui as { confirm?: (t: string, m: string) => Promise<boolean> }).confirm =
		async () => {
			confirmCalls += 1;
			return false;
		};
	const session = new VoiceSession({
		config: convoConfig({ autoSubmitTranscript: false }),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: createStubTtsAdapter({ latencyMs: 1 }),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
	});
	createVoiceExtension(harness.pi, {
		session,
		forceStubAdapters: true,
		shortcutProbe: allowlistShortcutProbe(["ctrl+alt+e"]),
	});
	session.dispatch({ type: "ENABLE" });
	await session.submitPending("voz enviada");
	session.dispatch({ type: "STOP" });
	await session.flush();
	await harness.runCommand("gentle-voice", "edit");
	assert.equal(confirmCalls, 1);
	assert.equal(harness.ctx.ui.getEditorText?.(), "texto previo del usuario");
	assert.equal(session.editHold, false);
});
