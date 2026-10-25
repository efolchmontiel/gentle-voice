/**
 * Silero onboarding. No network. No real XDG install.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { resolveBargeActivation } from "../lib/barge-in/preference.ts";
import { initialVoiceState, reduceVoiceState } from "../lib/state-machine.ts";
import { formatNoSpeechDetail, gateUtteranceForAutoSubmit } from "../lib/stt/utterance-gate.ts";
import { modelPathFrom, resolveVad } from "../lib/vad/resolve-vad.ts";
import {
	SILERO_STEPS,
	SILERO_VAD_BYTES,
	describeConversationReadiness,
	driveSileroInstall,
	formatSileroView,
	planSileroInstall,
	sileroModelPath,
	sileroPreferencePath,
	type SileroDriveHost,
} from "../lib/vad/silero-install.ts";
import { formatListenHint } from "../lib/vad/listen-stats.ts";
import { readCapabilities } from "../lib/runtime/capabilities.ts";
import { completeConversationSetup, formatConversationSetup } from "../lib/runtime/conversation-setup.ts";
import {
	gentleShellSherpaRuntimeDir,
	privateSherpaRuntimeDir,
	resolveSherpaRuntime,
	sherpaPackages,
	sherpaTarget,
} from "../lib/vad/sherpa-runtime.ts";

function isolatedEnv(root: string): NodeJS.ProcessEnv {
	return {
		HOME: root,
		XDG_DATA_HOME: join(root, "xdg"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_CACHE_HOME: join(root, "cache"),
	};
}

function host(input: {
	confirm?: () => Promise<boolean>;
	captureReady?: () => Promise<boolean>;
} = {}): SileroDriveHost & { notes: string[]; statuses: string[] } {
	const notes: string[] = [];
	const statuses: string[] = [];
	return {
		notes,
		statuses,
		notify: (message) => {
			notes.push(message);
		},
		...(input.confirm ? { confirm: async () => input.confirm!() } : {}),
		setStatus: (_key, text) => {
			if (text) statuses.push(text);
		},
		...(input.captureReady ? { captureReady: input.captureReady } : {}),
	};
}

const loadOk = async () => ({ ok: true as const, engine: { dispose() {} } });

/** Files the resolver checks; no native code is loaded in these tests. */
async function fakeRuntime(dir: string): Promise<void> {
	const target = sherpaTarget()!;
	for (const pkg of sherpaPackages(target)) {
		const file = join(dir, "node_modules", pkg.name, pkg.requiredFile);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, "");
	}
}

async function writeBytes(path: string, size: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, Buffer.alloc(size));
}

test("onboarding lists the five real progress steps", () => {
	const lines = formatSileroView(SILERO_STEPS.map((step) => ({ ...step, state: "pending" })));
	assert.match(lines.join("\n"), /Checking Silero VAD/);
	assert.match(lines.join("\n"), /Downloading Silero model/);
	assert.match(lines.join("\n"), /Verifying model integrity/);
	assert.match(lines.join("\n"), /Initializing VAD/);
	assert.match(lines.join("\n"), /Verifying microphone capture/);
});

test("new user without Silero is asked and a decline downloads nothing", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-silero-"));
	try {
		const env = isolatedEnv(root);
		let fetches = 0;
		const asked = host({ confirm: async () => false });
		const plan = await driveSileroInstall(asked, {
			env,
			io: { fetch: async () => { fetches += 1; } },
			loadVad: loadOk,
		});
		assert.equal(plan.status, "declined");
		assert.equal(fetches, 0);
		assert.match(asked.notes.join("\n"), /energy fallback/);
		const again = host({ confirm: async () => { throw new Error("must not ask again"); } });
		const second = await driveSileroInstall(again, { env, loadVad: loadOk });
		assert.equal(second.status, "declined");
		const vad = await resolveVad({ preference: "auto", env, silero: {} });
		assert.equal(vad.backend, "energy");
		assert.equal(vad.fallbackReason, undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("accepted download verifies size, initializes, and checks the microphone", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-silero-"));
	try {
		const env = isolatedEnv(root);
		const asked = host({
			confirm: async () => true,
			captureReady: async () => true,
		});
		const plan = await driveSileroInstall(asked, {
			env,
			loadVad: loadOk,
			io: {
				fetch: async (dest) => {
					await writeBytes(dest, SILERO_VAD_BYTES);
				},
				installRuntime: async () => {
					await fakeRuntime(privateSherpaRuntimeDir(sherpaTarget()!, env));
				},
			},
		});
		assert.equal(plan.status, "ready");
		assert.equal(resolveSherpaRuntime(env)?.source, "gentle-voice");
		assert.equal((await stat(plan.path)).size, SILERO_VAD_BYTES);
		assert.equal((await readFile(`${plan.path}.sha256`, "utf8")).includes(String(SILERO_VAD_BYTES)), true);
		assert.deepEqual(asked.statuses, [
			"Checking Silero VAD",
			"Downloading Silero",
			"Verifying model integrity",
			"Initializing VAD",
			"Verifying microphone capture",
			"Silero VAD",
		]);
		const seen = modelPathFrom({ preference: "auto", silero: {} }, env);
		assert.equal(seen, sileroModelPath(env));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("present model is reused silently without installation chrome or downloads", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-silero-"));
	try {
		const env = isolatedEnv(root);
		await writeBytes(sileroModelPath(env), SILERO_VAD_BYTES);
		await fakeRuntime(privateSherpaRuntimeDir(sherpaTarget()!, env));
		let fetches = 0;
		const asked = host({
			confirm: async () => { throw new Error("must not ask"); },
			captureReady: async () => true,
		});
		const widgets: unknown[] = [];
		asked.setWidget = (_key, content) => { widgets.push(content); };
		const plan = await driveSileroInstall(asked, {
			env,
			loadVad: loadOk,
			io: { fetch: async () => { fetches += 1; } },
		});
		assert.equal(plan.status, "ready");
		assert.equal(fetches, 0);
		assert.deepEqual(asked.notes, []);
		assert.deepEqual(asked.statuses, []);
		assert.deepEqual(widgets, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("corrupt model fails integrity and is not replaced without a successful download", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-silero-"));
	try {
		const env = isolatedEnv(root);
		const path = sileroModelPath(env);
		await writeBytes(path, 32);
		const asked = host({ confirm: async () => true });
		const plan = await driveSileroInstall(asked, {
			env,
			loadVad: loadOk,
			io: { fetch: async () => { throw new Error("silero_http_500"); } },
		});
		assert.equal(plan.status, "corrupt");
		assert.equal((await stat(path)).size, 32);
		assert.match(asked.notes.join("\n"), /silero_http_500/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("download disabled after consent does not fetch", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-silero-"));
	try {
		const env = { ...isolatedEnv(root), GENTLE_VOICE_DISABLE_DOWNLOADS: "1" };
		let fetches = 0;
		const asked = host({ confirm: async () => true });
		await driveSileroInstall(asked, {
			env,
			allowNetwork: false,
			io: { fetch: async () => { fetches += 1; } },
		});
		assert.equal(fetches, 0);
		assert.equal(await planSileroInstall(env).then((plan) => plan.status), "missing");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runtime load failure keeps the model and stays on energy", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-silero-"));
	try {
		const env = isolatedEnv(root);
		await writeBytes(sileroModelPath(env), SILERO_VAD_BYTES);
		await fakeRuntime(privateSherpaRuntimeDir(sherpaTarget()!, env));
		const asked = host({ captureReady: async () => true });
		const plan = await driveSileroInstall(asked, {
			env,
			loadVad: async () => ({ ok: false, reason: "silero_session_failed:boom" }),
		});
		assert.equal(plan.status, "ready");
		assert.equal((await stat(plan.path)).size, SILERO_VAD_BYTES);
		assert.match(asked.notes.join("\n"), /silero_session_failed/);
		assert.match(asked.notes.join("\n"), /Energy fallback/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("microphone without capture is reported after Silero initializes", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-silero-"));
	try {
		const env = isolatedEnv(root);
		await writeBytes(sileroModelPath(env), SILERO_VAD_BYTES);
		await fakeRuntime(privateSherpaRuntimeDir(sherpaTarget()!, env));
		const asked = host({ captureReady: async () => false });
		await driveSileroInstall(asked, { env, loadVad: loadOk });
		assert.match(asked.notes.join("\n"), /Microphone capture is not available/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a file in the XDG models dir is not reported as path_missing", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-silero-"));
	try {
		const env = isolatedEnv(root);
		await writeBytes(sileroModelPath(env), 16);
		const resolved = await resolveVad({ preference: "auto", env, silero: {} });
		assert.equal(resolved.backend, "energy");
		assert.notEqual(resolved.fallbackReason, "silero_model_path_missing");
		assert.equal(modelPathFrom({ preference: "auto" }, env), sileroModelPath(env));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("conversation mode is not ready when only TTS would be", () => {
	const missing = describeConversationReadiness({
		tts: "ready",
		stt: "ready",
		capture: "ready",
		playback: "ready",
		silero: "missing",
		vadBackend: "energy/silero_model_path_missing",
	});
	assert.match(missing.join("\n"), /conversationModeReady=no/);
	assert.match(missing.join("\n"), /Energy fallback is active/);
	assert.match(missing.join("\n"), /tts.ready=ready/);
	const ready = describeConversationReadiness({
		tts: "ready",
		stt: "ready",
		capture: "ready",
		playback: "ready",
		silero: "ready",
		vadBackend: "silero",
	});
	assert.match(ready.join("\n"), /conversationModeReady=yes/);
	assert.match(ready.join("\n"), /conversation.degraded=\(none\)/);
});

test("no speech reports level and duration and does not submit", () => {
	const detail = formatNoSpeechDetail({
		captureId: "pw-1",
		speechSeen: false,
		endReason: "stop",
		durationMs: 420,
		peakRms: 0.0012,
		meanRms: 0.0004,
		voicedMs: 0,
	});
	assert.match(detail, /peak 0.0012/);
	assert.match(detail, /420ms/);
	assert.match(detail, /end stop/);
	let state = initialVoiceState({ enabled: true, mode: "conversation" });
	state = reduceVoiceState(state, { type: "LISTEN" }).state;
	state = reduceVoiceState(state, { type: "CAPTURE_DONE" }).state;
	const empty = reduceVoiceState(state, { type: "TRANSCRIBE_EMPTY", detail });
	assert.equal(empty.state.phase, "idle");
	assert.equal(empty.effects.some((effect) => effect.type === "submit_transcript"), false);
	assert.match(empty.effects.map((effect) => effect.type === "notify" ? effect.message : "").join("\n"), /No speech detected. peak 0.0012/);
});

test("listen hint reports levels and does not store words", () => {
	const line = formatListenHint({
		stage: "capturing",
		device: "USB PnP Audio Device Mono",
		backend: "silero",
		chunks: 40,
		peak: 0.862,
		rms: 0.006,
		durationMs: 2200,
		speechProb: 0.001,
		voicedMs: 0,
		speechSeen: false,
		phase: "leading_silence",
		whisper: "not_called",
	});
	assert.match(line, /Capturing audio/);
	assert.match(line, /USB PnP Audio Device Mono/);
	assert.match(line, /prob 0.00/);
	assert.match(line, /whisper not_called/);
	assert.equal(line.includes("El Perú"), false);
});

test("declining Silero in the same assistant leaves conversation not ready", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-silero-"));
	try {
		const env = isolatedEnv(root);
		let fetches = 0;
		const asked = host({ confirm: async () => false, captureReady: async () => true });
		const caps = await completeConversationSetup(asked, env, {
			ttsInstalled: true,
			ttsReady: true,
			ttsActive: true,
			sttReady: true,
			playbackReady: true,
		});
		assert.equal(fetches, 0);
		assert.equal(caps.ttsReady, true);
		assert.equal(caps.vadReady, false);
		assert.equal(caps.vadChoice, "energy");
		assert.equal(caps.conversationReady, false);
		assert.match(caps.summary, /not the recommended setup/);
		assert.equal(readCapabilities(env)?.conversationReady, false);
		assert.match(formatConversationSetup(caps, false), /^Gentle Voice setup\n/);
		assert.match(formatConversationSetup(caps, true), /not ready/);
		assert.equal(formatConversationSetup({ ...caps, conversationReady: true }, true), "🎙️  Ready to talk");
		assert.match(formatConversationSetup({ ...caps, conversationReady: true }, false), /^Gentle Voice setup\n/);
		const again = host({ confirm: async () => { throw new Error("must not ask again"); } });
		await driveSileroInstall(again, {
			env,
			io: { fetch: async () => { fetches += 1; } },
			loadVad: loadOk,
		});
		assert.equal(fetches, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("energy threshold and barge-in contract stay put", () => {
	assert.equal(DEFAULT_VOICE_CONFIG.behavior.vadSpeechThreshold, 0.009);
	const gate = gateUtteranceForAutoSubmit({
		text: "hola",
		captureMeta: {
			captureId: "pw-2",
			speechSeen: true,
			endReason: "vad",
			durationMs: 400,
			peakRms: 0.2,
			meanRms: 0.1,
			voicedMs: 40,
		},
	});
	assert.equal(gate.accept, false);
	assert.equal(gate.reason, "voiced_too_short");
	assert.equal(resolveBargeActivation({ preference: "unset", fluentConversation: true }).enabled, true);
	assert.equal(resolveBargeActivation({ preference: "off", fluentConversation: true }).enabled, false);
	assert.equal(sileroPreferencePath({ HOME: "/tmp/gv-unused", XDG_DATA_HOME: "/tmp/gv-unused/xdg" }).endsWith("vad.json"), true);
});

test("the consent names both parts, what Silero does and the energy fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-silero-"));
	try {
		const env = isolatedEnv(root);
		let body = "";
		const asked = host({ confirm: async () => false });
		asked.confirm = async (_title, message) => {
			body = message;
			return false;
		};
		await driveSileroInstall(asked, { env, loadVad: loadOk });
		assert.match(body, /start and stop talking/);
		assert.match(body, /Silero model: ~2\.2 MiB \(MIT\)/);
		assert.match(body, /ONNX runtime \(sherpa-onnx/);
		assert.match(body, /Apache-2\.0/);
		assert.match(body, /energy detector/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a present model with a missing runtime installs only the runtime", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-silero-"));
	try {
		const env = isolatedEnv(root);
		await writeBytes(sileroModelPath(env), SILERO_VAD_BYTES);
		const before = await planSileroInstall(env);
		assert.equal(before.status, "missing");
		assert.equal(before.status === "missing" && before.modelPresent, true);
		let fetches = 0;
		let runtimes = 0;
		let body = "";
		const asked = host({ captureReady: async () => true });
		asked.confirm = async (_title, message) => {
			body = message;
			return true;
		};
		const plan = await driveSileroInstall(asked, {
			env,
			loadVad: loadOk,
			io: {
				fetch: async () => { fetches += 1; },
				installRuntime: async () => {
					runtimes += 1;
					await fakeRuntime(privateSherpaRuntimeDir(sherpaTarget()!, env));
				},
			},
		});
		assert.equal(fetches, 0);
		assert.equal(runtimes, 1);
		assert.match(body, /Silero model: already downloaded/);
		assert.equal(plan.status, "ready");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Gentle Shell's dictation runtime is reused and nothing is asked", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-silero-"));
	try {
		const env = { ...isolatedEnv(root), GENTLE_PI_CONFIG_HOME: join(root, "gentle-ai") };
		await writeBytes(sileroModelPath(env), SILERO_VAD_BYTES);
		await fakeRuntime(gentleShellSherpaRuntimeDir(sherpaTarget()!, env));
		assert.equal(resolveSherpaRuntime(env)?.source, "gentle-shell");
		const asked = host({
			confirm: async () => { throw new Error("must not ask"); },
			captureReady: async () => true,
		});
		const plan = await driveSileroInstall(asked, { env, loadVad: loadOk });
		assert.equal(plan.status, "ready");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
