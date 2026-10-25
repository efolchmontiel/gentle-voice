/**
 * Phase 2D.3 — incremental TTS, mic ARMING, UI cleanup, persona passthrough.
 * No LLM / no external credits.
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
import {
	extractTextDeltaFromMessageUpdate,
	isNonSpeakableAssistantEvent,
	SentenceAssembler,
} from "../lib/tts/sentence-assembler.ts";
import { StreamSpeakQueue } from "../lib/tts/stream-speak-queue.ts";
import { resolveChromeActivity } from "../lib/widget-chrome.ts";
import { initialVoiceState } from "../lib/state-machine.ts";
import { deniedShortcutProbe } from "../lib/shortcut.ts";

function convoConfig() {
	return {
		...DEFAULT_VOICE_CONFIG,
		enabled: true,
		behavior: {
			...DEFAULT_VOICE_CONFIG.behavior,
			mode: "conversation" as const,
			fluentConversation: true,
			autoSubmitTranscript: false,
			echoSettleMs: 0,
			muted: false,
		},
	};
}

test("2D.3 assembler: multi-fragment sentences, no mid-word cut", () => {
	// Unit tests pin Strategy A (1 sentence/unit); production uses Strategy B grouping.
	const a = new SentenceAssembler({ language: "es", minSentencesPerUnit: 1, minCharsPerUnit: 1 });
	assert.deepEqual(a.pushDelta("Hola hermano, "), []);
	const u1 = a.pushDelta("esto es una prueba. ");
	assert.equal(u1.length, 1);
	assert.match(u1[0]!.speakable, /Hola hermano/);
	assert.ok(!u1[0]!.speakable.includes("**"));
	const u2 = a.pushDelta("Segunda oración completa!");
	assert.equal(u2.length, 1);
	const rest = a.flush();
	assert.equal(rest.length, 0);
});

test("2D.3 assembler: markdown split across chunks", () => {
	const a = new SentenceAssembler({ language: "es", minSentencesPerUnit: 1, minCharsPerUnit: 1 });
	a.pushDelta("Mirá el **códi");
	const units = a.pushDelta("go** listo.");
	assert.equal(units.length, 1);
	assert.ok(!units[0]!.speakable.includes("*"));
	assert.match(units[0]!.speakable, /código|codigo/i);
});

test("2D.3 assembler: abbreviations not cut at soft flush", () => {
	const a = new SentenceAssembler({
		language: "es",
		softFlushChars: 30,
		minSentencesPerUnit: 1,
		minCharsPerUnit: 1,
	});
	// Force soft flush with long text without terminal punct.
	const long = "Usá el API de Node.js junto con C# y Angular en el backend ahora";
	const units = a.pushDelta(long);
	for (const u of units) {
		assert.ok(!/\bC\s*$/.test(u.speakable), "must not cut abbreviation C#");
		assert.ok(!u.speakable.endsWith("Node."), "must not cut Node.js");
	}
});

test("2D.3 extract text_delta; skip thinking/toolcall", () => {
	assert.equal(
		extractTextDeltaFromMessageUpdate({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hola" },
		}),
		"hola",
	);
	assert.equal(
		extractTextDeltaFromMessageUpdate({
			assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
		}),
		undefined,
	);
	assert.ok(
		isNonSpeakableAssistantEvent({
			assistantMessageEvent: { type: "toolcall_start" },
		}),
	);
	assert.ok(
		isNonSpeakableAssistantEvent({
			assistantMessageEvent: { type: "thinking_start" },
		}),
	);
});

test("2D.3 reconcile: no duplicate when stream covered final", () => {
	const a = new SentenceAssembler({ language: "es", minSentencesPerUnit: 1, minCharsPerUnit: 1 });
	const u = a.pushDelta("Todo bien hermano. ");
	a.markSpoken(u[0]!.speakable);
	assert.equal(a.remainderForFinal("Todo bien hermano."), "");
});

test("2D.3 stream queue: ordered play + cancel drops pending", async () => {
	const q = new StreamSpeakQueue(() => Date.now());
	q.begin();
	const played: string[] = [];
	q.enqueue([
		{ id: "1", raw: "A.", speakable: "A." },
		{ id: "2", raw: "B.", speakable: "B." },
		{ id: "3", raw: "C.", speakable: "C." },
	]);
	const ac = new AbortController();
	const p = q.kick(async (unit) => {
		played.push(unit.speakable);
		if (unit.speakable === "A.") q.cancel();
	}, ac.signal);
	await p;
	await q.idle();
	assert.equal(played[0], "A.");
	assert.ok(q.metrics.unitsDropped >= 1);
	assert.ok(!played.includes("C."));
});

test("2D.3 session stream: deltas → synth before settle; no Speaking notify", async () => {
	const harness = createPiHostHarness();
	const synthTexts: string[] = [];
	const session = new VoiceSession({
		config: convoConfig(),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "hola" }),
		tts: {
			...createStubTtsAdapter({ latencyMs: 1 }),
			async synthesize(text, opts) {
				synthTexts.push(text);
				return createStubTtsAdapter({ latencyMs: 1 }).synthesize(text, opts);
			},
		},
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
	});
	createVoiceExtension(harness.pi, {
		session,
		forceStubAdapters: true,
		shortcutProbe: deniedShortcutProbe(),
	});
	session.dispatch({ type: "ENABLE" });
	await session.submitPending("pregunta sobre Discord");
	harness.fire("agent_start", { type: "agent_start" });
	harness.fire("message_update", {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			delta: "Discord es una app de chat. ",
		},
	});
	harness.fire("message_update", {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			delta: "Sirve para comunidades.",
		},
	});
	// Allow pump to run before settle
	await new Promise((r) => setTimeout(r, 30));
	assert.ok(synthTexts.length >= 1, "must synth before agent_settled when sentence ready");
	assert.ok(session.latencySnapshot.firstTokenAtMs > 0);

	harness.fire("turn_end", {
		type: "turn_end",
		outcome: "completed",
		message: {
			role: "assistant",
			content: [{
				type: "text",
				text: "Discord es una app de chat. Sirve para comunidades.",
			}],
		},
	});
	harness.fire("agent_settled", { type: "agent_settled", aborted: false });
	await session.flush();
	await new Promise((r) => setTimeout(r, 40));
	assert.ok(!harness.notifies.some((n) => /🔊 Speaking:/i.test(n.message)));
	const joined = synthTexts.join(" ");
	assert.ok(!/thinking|toolcall/i.test(joined));
	// Persona passthrough: voseo from agent text preserved (no artificial rewrite).
	assert.equal(
		joined.includes("Sirve") || joined.includes("Discord"),
		true,
	);
});

test("2D.3 toolcall blocks stream → fallback final TTS", async () => {
	const harness = createPiHostHarness();
	const synthTexts: string[] = [];
	const session = new VoiceSession({
		config: convoConfig(),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: {
			...createStubTtsAdapter({ latencyMs: 1 }),
			async synthesize(text, opts) {
				synthTexts.push(text);
				return createStubTtsAdapter({ latencyMs: 1 }).synthesize(text, opts);
			},
		},
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
	});
	createVoiceExtension(harness.pi, {
		session,
		forceStubAdapters: true,
		shortcutProbe: deniedShortcutProbe(),
	});
	session.dispatch({ type: "ENABLE" });
	await session.submitPending("usa una tool");
	harness.fire("agent_start", {});
	harness.fire("message_update", {
		assistantMessageEvent: { type: "text_delta", delta: "Voy a revisar. " },
	});
	harness.fire("message_update", {
		assistantMessageEvent: { type: "toolcall_start", name: "bash" },
	});
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(session.streamMetrics.mode, "blocked");
	harness.fire("turn_end", {
		type: "turn_end",
		outcome: "completed",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Listo, ya revisé el archivo." }],
		},
	});
	harness.fire("agent_settled", { aborted: false });
	await session.flush();
	await new Promise((r) => setTimeout(r, 30));
	assert.ok(
		synthTexts.some((t) => /Listo|revisé|revise/i.test(t)),
		"fallback must speak final reliable text",
	);
});

test("2D.3 mute during stream cancels further synth", async () => {
	const session = new VoiceSession({
		config: convoConfig(),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: createStubTtsAdapter({ latencyMs: 5 }),
		playback: createStubPlaybackAdapter({ durationMs: 5 }),
	});
	session.dispatch({ type: "ENABLE" });
	session.beginStreamSpeak();
	session.onMessageUpdate({
		assistantMessageEvent: { type: "text_delta", delta: "Primera oración larga para probar. " },
	});
	session.dispatch({ type: "MUTE" });
	session.onMessageUpdate({
		assistantMessageEvent: { type: "text_delta", delta: "Esto no debe sonar." },
	});
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(session.streamActive, false);
});

test("2D.3 ARMING until micReady; LISTENING after", () => {
	const listening = initialVoiceState({ enabled: true, phase: "listening" });
	assert.equal(resolveChromeActivity(listening, { micReady: false }), "ARMING");
	assert.equal(resolveChromeActivity(listening, { micReady: true }), "LISTENING");
});

test("2D.3 listen cycle: stub marks mic ready + fluent re-listen", async () => {
	let finished = 0;
	const session = new VoiceSession({
		config: convoConfig(),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "" }),
		tts: createStubTtsAdapter({ latencyMs: 1 }),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
		onSpeakFinished: () => {
			finished += 1;
			session.scheduleFluentRelisten();
		},
	});
	session.dispatch({ type: "ENABLE" });
	await session.speakDirect("Respuesta corta.");
	await session.flush();
	assert.ok(finished >= 1);
	await new Promise((r) => setTimeout(r, 20));
	if (session.state.phase === "listening") {
		assert.equal(session.micReady, true);
		assert.equal(session.listenDiag.micReady, true);
	}
});

test("2D.3 Gentleman persona: agent voseo not rewritten by TTS path", () => {
	const a = new SentenceAssembler({ language: "es", minSentencesPerUnit: 1, minCharsPerUnit: 1 });
	const units = a.pushDelta("Dale, ponete las pilas y mirá el código.");
	assert.equal(units.length, 1);
	assert.match(units[0]!.speakable, /ponete|mirá/);
	assert.ok(!/ponte|mira el/i.test(units[0]!.speakable.replace("mirá", "")));
});

test("listen while a stream synth is still running waits for it instead of staying ARMING", async () => {
	let releaseSynth!: () => void;
	const synthGate = new Promise<void>((resolveGate) => {
		releaseSynth = resolveGate;
	});
	let captures = 0;
	const stubTts = createStubTtsAdapter({ latencyMs: 1 });
	const session = new VoiceSession({
		config: convoConfig(),
		capture: {
			id: "c",
			async availability() {
				return { status: "ready" };
			},
			async start() {
				captures += 1;
				return {
					id: "s",
					async stop() {
						return { bytes: new Uint8Array(8), sampleRateHz: 16_000, channels: 1, format: "pcm_s16le" };
					},
				};
			},
		},
		stt: createStubSttAdapter(),
		tts: {
			...stubTts,
			async synthesize(text, options) {
				await synthGate;
				return stubTts.synthesize(text, options);
			},
		},
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
	});
	session.dispatch({ type: "ENABLE" });
	session.beginStreamSpeak();
	session.onMessageUpdate({
		assistantMessageEvent: { type: "text_delta", delta: "Primera oración larga para probar el guard de eco. " },
	});
	await new Promise((r) => setTimeout(r, 10));
	session.dispatch({ type: "LISTEN" });
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(captures, 0, "the mic must stay closed while synthesis runs");
	releaseSynth();
	const deadline = Date.now() + 1000;
	while (captures === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
	assert.equal(captures, 1, "the mic opens once the queue drains");
	session.dispose();
});
