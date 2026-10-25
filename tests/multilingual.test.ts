/**
 * Spanish and English: language preference, Whisper auto detection, and the
 * spoken language each engine receives.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStubCaptureAdapter, createStubPlaybackAdapter } from "../lib/adapters/stubs.ts";
import { createWhisperSttAdapter, parseWhisperDetectedLanguage } from "../lib/adapters/whisper-stt.ts";
import { createKokoroWorkerTtsAdapter } from "../lib/adapters/kokoro-worker-tts.ts";
import { parseVoiceArgs } from "../lib/commands.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { converseStylePrompt } from "../lib/converse-style.ts";
import type { SttAdapter, TtsAdapter } from "../lib/contracts.ts";
import {
	parseVoiceLanguageMode,
	readVoiceLanguageMode,
	resolveVoiceLanguageMode,
	spokenLanguageFor,
	toSpokenLanguage,
	writeVoiceLanguageMode,
} from "../lib/language/voice-language.ts";
import { buildNarrationUserMessage } from "../lib/narration/narration-prompt.ts";
import { VoiceSession } from "../lib/voice-session.ts";

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "gv-lang-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("language mode parses, persists, and lets GENTLE_VOICE_LANG win", (t) => {
	const home = tempDir(t);
	assert.equal(readVoiceLanguageMode(home), "auto");
	writeVoiceLanguageMode(home, "en");
	assert.equal(readVoiceLanguageMode(home), "en");
	assert.equal(resolveVoiceLanguageMode(home, { GENTLE_VOICE_LANG: "es" }), "es");
	assert.equal(resolveVoiceLanguageMode(home, { GENTLE_VOICE_LANG: "fr" }), "en");
	assert.equal(parseVoiceLanguageMode(" EN "), "en");
	assert.equal(parseVoiceLanguageMode("pt"), undefined);
});

test("auto replies in the last detected language, Spanish before any turn", () => {
	assert.equal(spokenLanguageFor("auto", undefined), "es");
	assert.equal(spokenLanguageFor("auto", "en"), "en");
	assert.equal(spokenLanguageFor("es", "en"), "es");
	assert.equal(spokenLanguageFor("en", undefined), "en");
	assert.equal(toSpokenLanguage("english"), "en");
	assert.equal(toSpokenLanguage("pt"), undefined);
});

test("/gentle-voice lang is a public subcommand", () => {
	assert.deepEqual(parseVoiceArgs("lang en"), { command: "lang", rest: "en" });
});

test("Whisper auto passes -l auto and keeps the detection line visible", () => {
	const stt = createWhisperSttAdapter({ whisperCliPath: "/bin/true", modelPath: "/m.bin", dryRun: true });
	const auto = stt.buildPlan("a.wav", "auto").args;
	assert.deepEqual(auto.slice(auto.indexOf("-l"), auto.indexOf("-l") + 2), ["-l", "auto"]);
	assert.equal(auto.includes("-np"), false);
	const fixed = stt.buildPlan("a.wav", "es").args;
	assert.ok(fixed.includes("-np"));
	assert.equal(parseWhisperDetectedLanguage("whisper_full_with_state: auto-detected language: en (p = 0.96)"), "en");
	assert.equal(parseWhisperDetectedLanguage("nothing here"), undefined);
});

function fakeWhisper(dir: string, detected: string): { cli: string; model: string; calls: string } {
	const cli = join(dir, "whisper-cli");
	const calls = join(dir, "calls.log");
	writeFileSync(cli, [
		"#!/bin/sh",
		`echo "$*" >> "${calls}"`,
		'case "$*" in',
		`  *"-l auto"*) echo "whisper_full_with_state: auto-detected language: ${detected} (p = 0.41)" >&2; echo " auto text" ;;`,
		'  *) echo " texto en español" ;;',
		"esac",
	].join("\n"));
	chmodSync(cli, 0o755);
	const model = join(dir, "model.bin");
	writeFileSync(model, Buffer.concat([Buffer.from("lmgg"), Buffer.alloc(64)]));
	return { cli, model, calls };
}

/** The fake whisper-cli is a POSIX shell script. */
const shellScriptsSkip = process.platform === "win32" && "needs a POSIX shell";

const pcm = { bytes: new Uint8Array(3200), sampleRateHz: 16_000, channels: 1 as const, format: "pcm_s16le" as const };

test("Whisper auto returns the detected language for English", { skip: shellScriptsSkip }, async (t) => {
	const dir = tempDir(t);
	const { cli, model } = fakeWhisper(dir, "en");
	const stt = createWhisperSttAdapter({ whisperCliPath: cli, modelPath: model, tmpDir: dir });
	const result = await stt.transcribe(pcm, { signal: new AbortController().signal, language: "auto" });
	assert.deepEqual({ text: result.text, language: result.language }, { text: "auto text", language: "en" });
});

test("Whisper auto redoes a turn misread as another language in Spanish", { skip: shellScriptsSkip }, async (t) => {
	const dir = tempDir(t);
	const { cli, model, calls } = fakeWhisper(dir, "pt");
	const stt = createWhisperSttAdapter({ whisperCliPath: cli, modelPath: model, tmpDir: dir });
	const result = await stt.transcribe(pcm, { signal: new AbortController().signal, language: "auto" });
	assert.deepEqual({ text: result.text, language: result.language }, { text: "texto en español", language: "es" });
	const { readFileSync } = await import("node:fs");
	const runs = readFileSync(calls, "utf8").trim().split("\n");
	assert.equal(runs.length, 2);
	assert.match(runs[1]!, /-np .*-l es/);
});

function languageSession(mode: "auto" | "es" | "en", detected: string) {
	const sttLanguages: Array<string | undefined> = [];
	const ttsLanguages: Array<string | undefined> = [];
	const stt: SttAdapter = {
		id: "spy-stt",
		async availability() {
			return { status: "ready" };
		},
		async transcribe(_audio, { language }) {
			sttLanguages.push(language);
			return { text: "review the backend", language: detected };
		},
	};
	const tts: TtsAdapter = {
		id: "spy-tts",
		async availability() {
			return { status: "ready" };
		},
		async synthesize(_text, { language }) {
			ttsLanguages.push(language);
			return { audio: { bytes: new Uint8Array(8), sampleRateHz: 22_050, channels: 1, format: "raw" } };
		},
	};
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			engines: { ...DEFAULT_VOICE_CONFIG.engines, language: mode },
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, mode: "conversation", autoSubmitTranscript: false },
		},
		capture: createStubCaptureAdapter(),
		stt,
		tts,
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
		submitTranscript: () => {},
		notify: () => {},
	});
	return { session, sttLanguages, ttsLanguages };
}

async function oneTurn(session: VoiceSession): Promise<void> {
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	await session.speakDirect("All tests passed.");
}

test("auto mode: Whisper detects English and the reply is spoken in English", async () => {
	const { session, sttLanguages, ttsLanguages } = languageSession("auto", "en");
	assert.equal(session.spokenLanguage, "es");
	await oneTurn(session);
	assert.deepEqual(sttLanguages, ["auto"]);
	assert.deepEqual(ttsLanguages, ["en"]);
});

test("a fixed language ignores detection, and switching back to auto follows it again", async () => {
	const { session, sttLanguages, ttsLanguages } = languageSession("es", "en");
	await oneTurn(session);
	assert.deepEqual(sttLanguages, ["es"]);
	assert.deepEqual(ttsLanguages, ["es"]);
	session.setLanguageMode("en");
	await session.speakDirect("Done.");
	assert.equal(ttsLanguages.at(-1), "en");
	session.setLanguageMode("auto");
	assert.equal(session.spokenLanguage, "es");
});

test("Kokoro sends the English voice and language only for English", async (t) => {
	const dir = tempDir(t);
	const requests: Array<Record<string, unknown>> = [];
	const { PassThrough } = await import("node:stream");
	const { EventEmitter } = await import("node:events");
	const fakeWorker = () => {
		const proc = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			exitCode: null,
			kill: () => true,
		});
		proc.stdin.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").trim().split("\n")) {
				const req = JSON.parse(line) as { id: number; out: string };
				requests.push(req);
				const wav = Buffer.alloc(48);
				wav.write("RIFF", 0);
				wav.write("WAVE", 8);
				writeFileSync(req.out, wav);
				proc.stdout.write(`${JSON.stringify({ op: "done", id: req.id, sampleRate: 24000 })}\n`);
			}
		});
		setImmediate(() => proc.stdout.write(`${JSON.stringify({ op: "ready" })}\n`));
		return proc as never;
	};
	const kokoro = createKokoroWorkerTtsAdapter({ python: "/bin/true", script: "/bin/true", tmpDir: dir, spawnWorker: fakeWorker });
	const signal = new AbortController().signal;
	await kokoro.synthesize("Hola.", { signal, language: "es" }).catch(() => {});
	await kokoro.synthesize("Hello.", { signal, language: "en" }).catch(() => {});
	await kokoro.dispose();
	assert.deepEqual(requests.map((r) => [r.voice, r.lang]), [["ef_dora", "es"], ["af_heart", "en-us"]]);
});

test("the narrator writes in the spoken language and the style follows the mode", () => {
	assert.match(buildNarrationUserMessage("Listo.", "en"), /conversational English/);
	assert.match(buildNarrationUserMessage("Done."), /español conversacional/);
	assert.match(converseStylePrompt("en"), /inglés natural/);
	assert.match(converseStylePrompt("auto"), /idioma en que te habla/);
});
