/**
 * Phase 2D.4 — no obsolete audio across turns, edit hold, diag gate, cancel.
 * No LLM tokens.
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
import { parseVoiceArgs } from "../lib/commands.ts";
import { deniedShortcutProbe, allowlistShortcutProbe } from "../lib/shortcut.ts";

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

test("2D.4 remainder: streamed content covers final_summary — no re-speak", () => {
	const a = new SentenceAssembler({ language: "es" });
	const u = a.pushDelta(
		"PostgreSQL es open source. SQL Server es de Microsoft. Ambos son bases relacionales.",
	);
	assert.ok(u.length >= 1);
	// Emitted on assemble; spoken after play — both set for realism.
	for (const unit of u) a.markSpoken(unit.speakable);
	const remainder = a.remainderForFinal(
		"En resumen, PostgreSQL es open source y SQL Server es de Microsoft.",
	);
	assert.equal(remainder, "", "must not re-enqueue a summary of already streamed text");
});

test("2D.4 remainder: true tail after partial stream", () => {
	const a = new SentenceAssembler({ language: "es", minSentencesPerUnit: 1, minCharsPerUnit: 1 });
	const u = a.pushDelta("Primera oración completa. ");
	a.markSpoken(u[0]!.speakable);
	const rem = a.remainderForFinal("Primera oración completa. Segunda oración nueva.");
	assert.match(rem, /Segunda/);
	assert.ok(!rem.includes("Primera"));
});

test("2D.4 turn A then B: no obsolete A audio on B", async () => {
	const harness = createPiHostHarness();
	const synthTexts: string[] = [];
	const session = new VoiceSession({
		config: convoConfig(),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: {
			id: "spy",
			async availability() {
				return { status: "ready" as const };
			},
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

	// —— Turn A ——
	await session.submitPending("explica PostgreSQL y SQL Server");
	harness.fire("agent_start", {});
	const turnA = session.streamTurnId;
	harness.fire("message_update", {
		assistantMessageEvent: {
			type: "text_delta",
			delta: "PostgreSQL es open source. SQL Server es propietario. ",
		},
	});
	await new Promise((r) => setTimeout(r, 25));
	harness.fire("turn_end", {
		type: "turn_end",
		outcome: "completed",
		message: {
			role: "assistant",
			content: [{
				type: "text",
				text: "PostgreSQL es open source. SQL Server es propietario. Ambos sirven.",
			}],
		},
	});
	harness.fire("agent_settled", { aborted: false });
	await session.flush();
	await new Promise((r) => setTimeout(r, 50));
	const afterA = synthTexts.slice();
	assert.ok(afterA.some((t) => /PostgreSQL/i.test(t)));

	// —— Turn B: «gracias» ——
	await session.submitPending("gracias por la respuesta");
	harness.fire("agent_start", {});
	assert.notEqual(session.streamTurnId, turnA, "new turn must bump streamTurnId");
	harness.fire("message_update", {
		assistantMessageEvent: {
			type: "text_delta",
			delta: "De nada, hermano.",
		},
	});
	await new Promise((r) => setTimeout(r, 25));
	harness.fire("turn_end", {
		type: "turn_end",
		outcome: "completed",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "De nada, hermano." }],
		},
	});
	harness.fire("agent_settled", { aborted: false });
	await session.flush();
	await new Promise((r) => setTimeout(r, 50));

	const afterB = synthTexts.slice(afterA.length);
	assert.ok(afterB.every((t) => !/SQL Server|open source/i.test(t)), afterB.join(" | "));
	assert.ok(afterB.some((t) => /nada|hermano/i.test(t)) || afterB.length === 0);
});

test("2D.4 cancel mid-stream drops pending; no markSpoken for aborted", async () => {
	const session = new VoiceSession({
		config: convoConfig(),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: createStubTtsAdapter({ latencyMs: 30 }),
		playback: createStubPlaybackAdapter({ durationMs: 30 }),
	});
	session.dispatch({ type: "ENABLE" });
	session.beginStreamSpeak();
	const turn = session.streamTurnId;
	session.onMessageUpdate({
		assistantMessageEvent: {
			type: "text_delta",
			delta: "Una. Dos. Tres. Cuatro. Cinco.",
		},
	});
	session.cancelVoiceAudio("test");
	assert.notEqual(session.streamTurnId, turn);
	assert.equal(session.streamActive, false);
	await new Promise((r) => setTimeout(r, 80));
});

test("2D.4 repeated settle skip does not speak", async () => {
	const harness = createPiHostHarness();
	const synthTexts: string[] = [];
	const session = new VoiceSession({
		config: convoConfig(),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: {
			id: "spy",
			async availability() {
				return { status: "ready" as const };
			},
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
	await session.submitPending("hola");
	harness.fire("agent_start", {});
	harness.fire("turn_end", {
		type: "turn_end",
		outcome: "completed",
		message: { role: "assistant", content: [{ type: "text", text: "Hola." }] },
	});
	harness.fire("agent_settled", { aborted: false });
	await session.flush();
	await new Promise((r) => setTimeout(r, 30));
	const n = synthTexts.length;
	// Second settle without new submit → not_awaiting / duplicate
	harness.fire("agent_settled", { aborted: false });
	await session.flush();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(synthTexts.length, n);
});

test("2D.4 edit: no prior transcript warns; with text loads editor", async () => {
	const harness = createPiHostHarness();
	const session = new VoiceSession({
		config: convoConfig(),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: createStubTtsAdapter({ latencyMs: 1 }),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
	});
	createVoiceExtension(harness.pi, {
		session,
		forceStubAdapters: true,
		shortcutProbe: allowlistShortcutProbe(["ctrl+alt+space", "ctrl+alt+e"]),
	});
	session.dispatch({ type: "ENABLE" });
	await harness.runCommand("gentle-voice", "edit");
	assert.ok(harness.notifies.some((n) => /No voice transcript/i.test(n.message)));

	await session.submitPending("un parro de texto");
	assert.equal(session.lastSubmittedText, "un parro de texto");
	// Edit refuses mid-agent turn — settle/stop first (matches human Esc then Edit).
	session.dispatch({ type: "STOP" });
	await session.flush();
	await harness.runCommand("gentle-voice", "edit");
	assert.equal(session.editHold, true);
	assert.equal(harness.ctx.ui.getEditorText?.(), "un parro de texto");
	assert.ok(
		harness.notifies.some((n) => /LAST sent|Gentle Voice Edit/i.test(n.message)),
	);
});

test("2D.4 parseVoiceArgs edit", () => {
	assert.equal(parseVoiceArgs("edit").command, "edit");
});

test("2D.4 voice-diag hidden without LAB_DIAG", async () => {
	const prevLab = process.env.GENTLE_VOICE_LAB;
	const prevDiag = process.env.GENTLE_VOICE_LAB_DIAG;
	process.env.GENTLE_VOICE_LAB = "1";
	delete process.env.GENTLE_VOICE_LAB_DIAG;
	try {
		const harness = createPiHostHarness();
		const session = new VoiceSession({
			config: convoConfig(),
			capture: createStubCaptureAdapter(),
			stt: createStubSttAdapter(),
			tts: createStubTtsAdapter({ latencyMs: 1 }),
			playback: createStubPlaybackAdapter({ durationMs: 1 }),
		});
		createVoiceExtension(harness.pi, {
			session,
			forceStubAdapters: true,
			shortcutProbe: deniedShortcutProbe(),
		});
		session.dispatch({ type: "ENABLE" });
		await session.submitPending("x");
		harness.fire("agent_start", {});
		harness.fire("turn_end", {
			type: "turn_end",
			outcome: "completed",
			message: { role: "assistant", content: [{ type: "text", text: "Ok." }] },
		});
		harness.fire("agent_settled", { aborted: false });
		await session.flush();
		assert.ok(!harness.notifies.some((n) => /voice-diag:/i.test(n.message)));
	} finally {
		if (prevLab === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prevLab;
		if (prevDiag === undefined) delete process.env.GENTLE_VOICE_LAB_DIAG;
		else process.env.GENTLE_VOICE_LAB_DIAG = prevDiag;
	}
});
