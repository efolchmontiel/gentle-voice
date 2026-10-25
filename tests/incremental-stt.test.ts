/**
 * Incremental STT — provisional UI only; never double-submit; cancel drops stale.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AudioChunk, SttAdapter, SttResult } from "../lib/contracts.ts";
import {
	createIncrementalSttController,
	isIncrementalSttEnabled,
} from "../lib/stt/incremental-stt.ts";
import { renderVoiceWidgetContent, snapshotVoiceChrome } from "../lib/widget-chrome.ts";
import { initialVoiceState } from "../lib/state-machine.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";

function pcmTone(bytes: number): Uint8Array {
	const buf = Buffer.alloc(bytes);
	for (let i = 0; i < bytes; i += 2) {
		buf.writeInt16LE(8000, i);
	}
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function speechAudio(textBytes = 32_000): AudioChunk {
	return {
		format: "pcm_s16le",
		sampleRateHz: 16_000,
		channels: 1,
		bytes: pcmTone(textBytes),
		captureMeta: {
			captureId: "cap-test",
			durationMs: 1000,
			speechSeen: true,
			endReason: "vad",
			peakRms: 0.2,
			meanRms: 0.15,
		},
	};
}

function fakeStt(texts: string[]) {
	let i = 0;
	const adapter = {
		id: "fake-stt",
		calls: 0,
		partialCalls: 0,
		async availability() {
			return { status: "ready" as const };
		},
		async transcribe(): Promise<SttResult> {
			adapter.calls += 1;
			return { text: texts[Math.min(i, texts.length - 1)] ?? "", confidence: 1 };
		},
		async transcribePartial(): Promise<SttResult> {
			adapter.partialCalls += 1;
			const text = texts[Math.min(i++, texts.length - 1)] ?? "";
			return { text, confidence: 0.5 };
		},
	};
	return adapter;
}

test("isIncrementalSttEnabled: env overrides config", () => {
	assert.equal(isIncrementalSttEnabled(false, { GENTLE_VOICE_INCREMENTAL_STT: "1" }), true);
	assert.equal(isIncrementalSttEnabled(true, { GENTLE_VOICE_INCREMENTAL_STT: "0" }), false);
	assert.equal(isIncrementalSttEnabled(true, {}), true);
	assert.equal(isIncrementalSttEnabled(false, {}), false);
});

test("incremental controller: single-flight replace text; cancel drops stale", async () => {
	const partials: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let started = 0;
	const stt: SttAdapter & {
		transcribePartial: (
			a: AudioChunk,
			o: { signal: AbortSignal },
		) => Promise<SttResult>;
	} = {
		id: "gated",
		async availability() {
			return { status: "ready" };
		},
		async transcribe() {
			return { text: "final-should-not-run" };
		},
		async transcribePartial(_a, { signal }) {
			started += 1;
			await gate;
			if (signal.aborted) {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			return { text: `parcial-${started}` };
		},
	};

	const ctrl = createIncrementalSttController({
		stt,
		minPcmBytes: 100,
		minNewBytes: 50,
		intervalMs: 10_000,
		onPartial: (ev) => partials.push(ev.text),
	});

	ctrl.markSpeechSeen();
	ctrl.pushPcm(pcmTone(200));
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(started, 1);
	ctrl.pushPcm(pcmTone(200));
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(started, 1, "must not start a second concurrent whisper");

	await ctrl.cancelInFlight();
	release();
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(partials.length, 0);
	assert.equal(ctrl.getProvisional(), "");
	assert.equal(ctrl.isSealed(), true);
	ctrl.dispose();
});

test("incremental controller: accepted partial replaces (no append duplication)", async () => {
	const seen: string[] = [];
	const stt = fakeStt(["hola", "hola mundo", "hola mundo completo"]);
	const ctrl = createIncrementalSttController({
		stt,
		minPcmBytes: 100,
		minNewBytes: 50,
		intervalMs: 5,
		onPartial: (ev) => seen.push(ev.text),
	});
	ctrl.markSpeechSeen();
	ctrl.pushPcm(pcmTone(200));
	await new Promise((r) => setTimeout(r, 40));
	ctrl.pushPcm(pcmTone(200));
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(seen.length >= 1);
	assert.ok(!seen.some((t) => /hola hola/.test(t)));
	ctrl.dispose();
});

test("chrome distinguishes parcial vs final preview", () => {
	const state = initialVoiceState({ enabled: true, mode: "conversation", muted: false });
	const partial = renderVoiceWidgetContent(state, {
		micReady: true,
		transcriptPreview: "probando silero",
		transcriptPreviewKind: "partial",
	});
	assert.ok(partial?.some((l) => l.startsWith("… ")));
	const fin = renderVoiceWidgetContent(state, {
		micReady: true,
		transcriptPreview: "probando silero",
		transcriptPreviewKind: "final",
	});
	assert.ok(fin?.some((l) => l.startsWith("✓ ")));
	const decoding = renderVoiceWidgetContent(state, {
		micReady: true,
		transcriptPreviewKind: "decoding",
	});
	assert.ok(decoding?.some((l) => l === "⋯ escuchando"));
	assert.ok(!decoding?.some((l) => l.includes("probando")));
	const snap = snapshotVoiceChrome(state, {
		micReady: true,
		transcriptPreview: "x",
		transcriptPreviewKind: "partial",
	});
	assert.match(snap.statusText ?? "", /parcial/);
});

test("stale partial clears after threshold (no frozen … text)", async () => {
	let clock = 1_000;
	const statuses: string[] = [];
	const stt = fakeStt(["texto viejo"]);
	const ctrl = createIncrementalSttController({
		stt,
		minPcmBytes: 100,
		minNewBytes: 50,
		intervalMs: 50,
		staleMs: 200,
		decodingHideMs: 10_000,
		now: () => clock,
		onPartial: () => {},
		onStatus: (ev) => statuses.push(ev.status),
	});
	ctrl.markSpeechSeen();
	ctrl.pushPcm(pcmTone(200));
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(ctrl.getProvisional(), "texto viejo");
	// Advance past staleMs without a new accept; pushPcm ticks freshness.
	clock += 250;
	ctrl.pushPcm(pcmTone(50));
	assert.equal(ctrl.getProvisional(), "");
	assert.ok(statuses.includes("stale_cleared") || statuses.includes("decoding"));
	assert.ok(ctrl.metrics.staleClears >= 1 || ctrl.metrics.decodingSignals >= 1);
	ctrl.dispose();
});

test("long decode hides provisional via decoding status", async () => {
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const stt: SttAdapter & {
		transcribePartial: (
			a: AudioChunk,
			o: { signal: AbortSignal },
		) => Promise<SttResult>;
	} = {
		id: "two-phase",
		async availability() {
			return { status: "ready" };
		},
		async transcribe() {
			return { text: "f" };
		},
		async transcribePartial() {
			calls += 1;
			if (calls === 1) return { text: "primero" };
			await gate;
			return { text: "segundo" };
		},
	};
	let clock = 10_000;
	const statuses: string[] = [];
	const ctrl = createIncrementalSttController({
		stt,
		minPcmBytes: 100,
		minNewBytes: 50,
		intervalMs: 30,
		staleMs: 60_000,
		decodingHideMs: 80,
		now: () => clock,
		onPartial: () => {},
		onStatus: (ev) => statuses.push(ev.status),
	});
	ctrl.markSpeechSeen();
	ctrl.pushPcm(pcmTone(200));
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(ctrl.getProvisional(), "primero");
	const started = calls;
	ctrl.pushPcm(pcmTone(200));
	// The long decode starts on the interval timer, which a fixed sleep can miss.
	await new Promise((r) => setTimeout(r, 25));
	const deadline = Date.now() + 1_000;
	while (calls === started && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.ok(calls > started, "the long decode never started");
	clock += 120;
	ctrl.pushPcm(pcmTone(20));
	assert.equal(ctrl.getProvisional(), "");
	assert.ok(statuses.includes("decoding"));
	release();
	await new Promise((r) => setTimeout(r, 40));
	ctrl.dispose();
});

test("no speechSeen → no whisper attempts (silence hallucination guard)", async () => {
	const stt = fakeStt(["el Perú"]);
	const ctrl = createIncrementalSttController({
		stt,
		minPcmBytes: 100,
		minNewBytes: 50,
		intervalMs: 20,
	});
	ctrl.pushPcm(pcmTone(400));
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(stt.partialCalls, 0);
	assert.equal(ctrl.getProvisional(), "");
	assert.ok(ctrl.metrics.droppedNoSpeech >= 1);
	ctrl.dispose();
});

test("seal stops timer — late decode cannot publish", async () => {
	const partials: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const stt: SttAdapter & {
		transcribePartial: (
			a: AudioChunk,
			o: { signal: AbortSignal },
		) => Promise<SttResult>;
	} = {
		id: "late",
		async availability() {
			return { status: "ready" };
		},
		async transcribe() {
			return { text: "f" };
		},
		async transcribePartial(_a, { signal }) {
			await gate;
			if (signal.aborted) {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			return { text: "el Perú" };
		},
	};
	const ctrl = createIncrementalSttController({
		stt,
		minPcmBytes: 100,
		minNewBytes: 50,
		intervalMs: 15,
		onPartial: (ev) => partials.push(ev.text),
	});
	ctrl.markSpeechSeen();
	ctrl.pushPcm(pcmTone(200));
	await new Promise((r) => setTimeout(r, 25));
	ctrl.seal();
	release();
	await new Promise((r) => setTimeout(r, 40));
	// Post-seal interval must not start new attempts that publish.
	ctrl.pushPcm(pcmTone(200));
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(partials, []);
	assert.equal(ctrl.getProvisional(), "");
	assert.equal(ctrl.isSealed(), true);
	ctrl.dispose();
});

test("session: partial never calls submitTranscript; final can", async () => {
	const submitted: string[] = [];
	let pcmCb: ((pcm: Uint8Array, meta: { channels: number; sampleRateHz: number }) => void) | undefined;

	const stt = {
		id: "sess-stt",
		partialCalls: 0,
		finalCalls: 0,
		async availability() {
			return { status: "ready" as const };
		},
		async transcribe(): Promise<SttResult> {
			stt.finalCalls += 1;
			return { text: "transcripcion final para el agente pi", confidence: 1 };
		},
		async transcribePartial(): Promise<SttResult> {
			stt.partialCalls += 1;
			await new Promise((r) => setTimeout(r, 5));
			return { text: "borrador parcial", confidence: 0.5 };
		},
	};

	const capture = {
		id: "cap",
		async availability() {
			return { status: "ready" as const, detail: "stub" };
		},
		async start(opts: {
			signal: AbortSignal;
			onPcmChunk?: (pcm: Uint8Array, meta: { channels: number; sampleRateHz: number }) => void;
			onFirstPcm?: (info: { captureId: string; atMs: number }) => void;
			onSpeechSeen?: (info: { captureId: string; atMs: number }) => void;
		}) {
			pcmCb = opts.onPcmChunk;
			opts.onFirstPcm?.({ captureId: "c1", atMs: Date.now() });
			opts.onSpeechSeen?.({ captureId: "c1", atMs: Date.now() });
			return {
				id: "c1",
				async stop() {
					return speechAudio();
				},
			};
		},
	};

	const prev = process.env.GENTLE_VOICE_INCREMENTAL_STT;
	process.env.GENTLE_VOICE_INCREMENTAL_STT = "1";

	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				autoSubmitTranscript: true,
				fluentConversation: false,
				incrementalStt: true,
			},
		},
		capture: capture as never,
		stt: stt as never,
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		submitTranscript: (t) => {
			submitted.push(t);
		},
	});

	session.dispatch({ type: "ENABLE" });
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	pcmCb?.(pcmTone(40_000), { channels: 1, sampleRateHz: 16_000 });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(submitted.length, 0, "partial must not submit to Pi");

	await session.finishListen();
	await session.flush();
	await new Promise((r) => setTimeout(r, 20));

	assert.equal(stt.finalCalls, 1);
	assert.equal(submitted.length, 1);
	assert.equal(submitted[0], "transcripcion final para el agente pi");
	assert.ok(!submitted.includes("borrador parcial"));
	session.dispose();

	if (prev === undefined) delete process.env.GENTLE_VOICE_INCREMENTAL_STT;
	else process.env.GENTLE_VOICE_INCREMENTAL_STT = prev;
});

test("session fallback: incremental off uses classic STT only", async () => {
	const prev = process.env.GENTLE_VOICE_INCREMENTAL_STT;
	delete process.env.GENTLE_VOICE_INCREMENTAL_STT;

	const stt = fakeStt(["frase final de prueba"]);
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				incrementalStt: false,
				autoSubmitTranscript: true,
				fluentConversation: false,
			},
		},
		capture: createStubCaptureAdapter({ audio: speechAudio() }),
		stt: stt as never,
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		submitTranscript: () => {},
	});
	session.dispatch({ type: "ENABLE" });
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	assert.equal(stt.partialCalls, 0);
	assert.ok(stt.calls >= 1);
	session.dispose();

	if (prev !== undefined) process.env.GENTLE_VOICE_INCREMENTAL_STT = prev;
});
