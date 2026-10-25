import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { parseVoiceArgs, VOICE_COMMAND } from "../lib/commands.ts";
import { createFakeProcess, CancellationBag } from "../lib/process-cancel.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { createVoiceExtension } from "../extensions/voice.ts";
import type { VoiceHostApi } from "../lib/contracts.ts";

function sessionWithStubs(text = "hello world") {
	const submitted: string[] = [];
	const notes: string[] = [];
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, autoSubmitTranscript: true },
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
		submitTranscript: (t) => {
			submitted.push(t);
		},
		notify: (m) => {
			notes.push(m);
		},
	});
	return { session, submitted, notes };
}

test("listen → finishListen submits transcript via stubs", async () => {
	const { session, submitted } = sessionWithStubs("fix flaky test");
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	assert.equal(session.state.phase, "listening");
	await session.finishListen();
	await session.flush();
	assert.deepEqual(submitted, ["fix flaky test"]);
	assert.equal(session.state.phase, "awaiting_agent");
});

test("onAgentSettled speaks only conversation summaries", async () => {
	const { session } = sessionWithStubs();
	session.dispatch({ type: "LISTEN" });
	await session.finishListen();
	await session.flush();

	const decision = session.onAgentSettled({
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "bash" },
				{ type: "text", text: "In summary, the flaky test is quarantined." },
			],
		},
		outcome: "completed",
	});
	await session.flush();
	assert.equal(decision.speak, true);
	assert.match(decision.text, /summary|quarantined/i);
	assert.equal(session.state.phase, "idle");
});

test("silent mode never speaks", async () => {
	const { session } = sessionWithStubs("hi");
	session.dispatch({ type: "SET_MODE", mode: "silent" });
	session.dispatch({ type: "LISTEN" });
	await session.finishListen();
	await session.flush();
	const decision = session.onAgentSettled({
		message: { role: "assistant", content: [{ type: "text", text: "All good." }] },
		outcome: "completed",
	});
	assert.equal(decision.speak, false);
});

test("parseVoiceArgs covers subcommands", () => {
	assert.equal(parseVoiceArgs("").command, "");
	assert.equal(parseVoiceArgs("on").command, "on");
	assert.equal(parseVoiceArgs("status").command, "status");
	assert.ok(parseVoiceArgs("nope").error);
	assert.equal(VOICE_COMMAND, "gentle-voice");
});

test("CancellationBag aborts derived signals", () => {
	const bag = new CancellationBag();
	const signal = bag.derive();
	assert.equal(signal.aborted, false);
	bag.abortAll();
	assert.equal(signal.aborted, true);
});

test("fake process cancels on abort", async () => {
	const controller = new AbortController();
	const proc = createFakeProcess({ delayMs: 5_000, signal: controller.signal });
	controller.abort();
	const result = await proc.exit;
	assert.equal(result.signal, "SIGTERM");
});

test("extension registers /gentle-voice without Pi install", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const notifications: string[] = [];
	const pi: VoiceHostApi = {
		registerCommand(name, options) {
			commands.set(name, options as never);
		},
		sendUserMessage() {},
	};
	createVoiceExtension(pi, {
		config: { ...DEFAULT_VOICE_CONFIG, enabled: false },
	});
	assert.ok(commands.has("gentle-voice"));
	// Gentle Shell owns /gentle:voice (native dictation).
	assert.ok(!commands.has("gentle:voice"));

	const ctx = {
		mode: "tui" as const,
		hasUI: true,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
			setWidget() {},
		},
		isIdle: () => true,
	};
	await commands.get("gentle-voice")!.handler("status", ctx as never);
	assert.ok(notifications.some((n) => n.includes("platform=")));
});
