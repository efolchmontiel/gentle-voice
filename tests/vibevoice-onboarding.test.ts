import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { nativeVibeVoiceStreamEnabled } from "../lib/adapters/vibevoice-pcm.ts";
import { extractTarMember, parseTarListing } from "../lib/vibevoice/archive.ts";
import type { VibeVoiceArtifact } from "../lib/vibevoice/manifest.ts";
import {
	createInstallChecklist,
	formatInstallView,
} from "../lib/vibevoice/install-progress.ts";
import {
	runVibeVoiceOnboarding,
	uninstallVibeVoiceEngine,
	type OnboardingIo,
} from "../lib/vibevoice/onboarding.ts";
import { vibeVoicePythonSupported } from "../lib/vibevoice/python-runtime.ts";
import { planVibeVoiceInstall } from "../lib/vibevoice/install-plan.ts";
import {
	chooseTtsEngine,
	readTtsEnginePreference,
	resolvePreferredTts,
	writeTtsEnginePreference,
} from "../lib/vibevoice/tts-preference.ts";
import { resolveLabVoiceAdapters } from "../lib/adapters/lab-resolve.ts";

const hardware = { nvidiaPresent: true, vramTotalMb: 8192, freeDiskMb: 20000 };

function artifact(id: VibeVoiceArtifact["id"], relativePath: string, body: string): VibeVoiceArtifact {
	const bytes = Buffer.from(body);
	return {
		id,
		relativePath,
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		origin: `fixture://${id}`,
	};
}

function fixtures(): { artifacts: VibeVoiceArtifact[]; bodies: Map<string, string> } {
	const specs = [
		artifact("weights", "models/VibeVoice-Realtime-0.5B/model.safetensors", "weights-ok"),
		artifact("spanish-voice", "voices/sp-Spk0_woman.pt", "voice-ok"),
		artifact("code-license", "code/LICENSE", "MIT"),
		artifact("code-project", "code/pyproject.toml", "[project]\nname='vibevoice'\n"),
	];
	return { artifacts: specs, bodies: new Map(specs.map((item) => [item.id, {
		weights: "weights-ok",
		"spanish-voice": "voice-ok",
		"code-license": "MIT",
		"code-project": "[project]\nname='vibevoice'\n",
	}[item.id]!])) };
}

function slash(value: string): string {
	return value.replace(/\\/g, "/");
}

function fakeIo(bodies: Map<string, string>, calls: string[], opts?: { fail?: string; corrupt?: string }): OnboardingIo {
	return {
		async fetch(item, destination) {
			calls.push(`fetch:${item.id}`);
			if (opts?.fail === item.id) throw new Error(`boom:${item.id}`);
			const body = opts?.corrupt === item.id ? "corrupt" : bodies.get(item.id)!;
			writeFileSync(destination, body);
		},
		async run(command, args) {
			calls.push([command, ...args].join(" "));
			const commandPath = slash(command);
			if (args[0] === "-c" && String(args[1]).includes("GVPY")) {
				return { code: 0, detail: "GVPY 3.14" };
			}
			if (command === "sudo" || args.includes("sudo")) return { code: 9 };
			if (args[0] === "-m" && args[1] === "venv") {
				const venv = args[2]!;
				mkdirSync(join(venv, "bin"), { recursive: true });
				writeFileSync(join(venv, "bin", "python"), "#!/bin/sh\nexit 0\n");
				writeFileSync(join(venv, "bin", "pip"), "#!/bin/sh\nexit 0\n");
			}
			if (commandPath.endsWith("/.venv/bin/python") && args.includes("sys.prefix.endswith('.venv')")) return { code: 0 };
			if (commandPath.endsWith("/.venv/bin/python") && args.some((arg) => arg.includes("importlib.metadata"))) {
				return { code: calls.some((call) => slash(call).includes("/.venv/bin/pip install")) ? 0 : 4 };
			}
			if (commandPath.endsWith("/.venv/bin/pip")) {
				if (opts?.fail === "pip") return { code: 1, detail: "ERROR: pip stopped\nNo matching distribution" };
				return { code: 0 };
			}
			return { code: 0 };
		},
	};
}

function layout(): { root: string; target: string; voiceHome: string; outside: string } {
	const root = mkdtempSync(join(tmpdir(), "gv-vv-onboard-"));
	const target = join(root, "engine");
	const voiceHome = join(root, "voice-home");
	mkdirSync(voiceHome, { recursive: true });
	const outside = join(root, "outside.txt");
	writeFileSync(outside, "keep");
	return { root, target, voiceHome, outside };
}

test("hardware below the measured tree is blocked and 6 GB VRAM stays untested", () => {
	const blocked = planVibeVoiceInstall({
		targetDir: "/tmp/gv-plan",
		hardware: { nvidiaPresent: true, vramTotalMb: 8192, freeDiskMb: 9000 },
		alreadyInstalled: false,
	});
	assert.equal(blocked.status, "blocked");
	assert.equal(blocked.reasons.includes("disk_below_12gb"), true);
	const untested = planVibeVoiceInstall({
		targetDir: "/tmp/gv-plan",
		hardware: { nvidiaPresent: true, vramTotalMb: 6144, freeDiskMb: 20000 },
		alreadyInstalled: false,
	});
	assert.equal(untested.status, "needs_consent");
	assert.equal(untested.reasons.includes("vram_above_minimum_untested"), true);
});

test("declining consent does not fetch and does not select Piper", async () => {
	const { target, voiceHome, outside } = layout();
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: false,
		allowNetwork: true,
		io: fakeIo(bodies, calls),
		artifacts,
	});
	assert.equal(result.status, "declined");
	assert.equal(calls.some((call) => call.startsWith("fetch:")), false);
	assert.equal(readTtsEnginePreference(voiceHome), "unset");
	assert.equal(readFileSync(outside, "utf8"), "keep");
});

test("consent without network authorization does not download or mark the engine", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: false,
		io: fakeIo(bodies, calls),
		artifacts,
	});
	assert.equal(result.status, "network_not_authorized");
	assert.equal(calls.length, 0);
	assert.equal(readTtsEnginePreference(voiceHome), "unset");
});

test("simulated install verifies hashes, uses a private venv, and selects PCM", async () => {
	const { target, voiceHome, outside } = layout();
	writeFileSync(join(voiceHome, "..", "outside.txt"), "keep");
	mkdirSync(join(target, ".download-cache"), { recursive: true });
	writeFileSync(join(target, ".download-cache", "source.tgz"), "archive");
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	const progress: string[] = [];
	let lastSteps: { id: string; state: string }[] = [];
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, calls),
		artifacts,
		onProgress: (event) => {
			progress.push(event.message);
			lastSteps = event.steps.map((step) => ({ id: step.id, state: step.state }));
		},
	});
	assert.equal(result.status, "installed");
	assert.equal(result.engine, "vibevoice");
	assert.equal(result.voice, "sp-Spk0_woman");
	assert.equal(result.playback, "pcm");
	assert.equal(nativeVibeVoiceStreamEnabled({ HOME: voiceHome, GENTLE_VOICE_HOME: voiceHome }, true), true);
	assert.equal(readTtsEnginePreference(voiceHome), "vibevoice");
	const marker = JSON.parse(readFileSync(join(target, "INSTALL_PENDING.json"), "utf8")) as { authorized?: boolean };
	assert.equal(marker.authorized, true);
	const receipt = JSON.parse(readFileSync(join(target, "integrity.json"), "utf8")) as { kind?: string };
	assert.equal(receipt.kind, "gentle-voice.vibevoice-integrity");
	assert.equal(calls.some((call) => call.startsWith("python3.14 -m venv ") && slash(call).includes(slash(target))), true);
	assert.equal(calls.some((call) => slash(call).includes("/.venv/bin/pip install")), true);
	assert.equal(calls.some((call) => call.startsWith("sudo")), false);
	assert.equal(readFileSync(outside, "utf8"), "keep");
	assert.equal(progress[0], "Installing VibeVoice...");
	assert.equal(progress.includes("Installing dependencies"), true);
	assert.equal(progress.includes("Verifying voice engine"), true);
	assert.equal(progress.indexOf("Installing dependencies") < progress.indexOf("Verifying voice engine"), true);
	assert.deepEqual(lastSteps.map((step) => step.id), [
		"weights",
		"source",
		"python",
		"dependencies",
		"spanish",
		"engine",
		"activate",
	]);
	assert.equal(lastSteps.find((step) => step.id === "weights")?.state, "completed");
	assert.equal(lastSteps.find((step) => step.id === "python")?.state, "completed");
	assert.equal(lastSteps.find((step) => step.id === "activate")?.state, "pending");
	const pipAt = calls.findIndex((call) => slash(call).includes("/.venv/bin/pip install"));
	assert.equal(pipAt > 0, true);
	const pipCalls = calls.filter((call) => slash(call).includes("/.venv/bin/pip install"));
	assert.equal(pipCalls.length, 2);
	assert.ok(pipCalls.every((call) => call.includes(" --no-cache-dir ")));
	assert.match(pipCalls[0]!, / --no-deps -e /);
	assert.doesNotMatch(pipCalls[0]!, /\[streamingtts\]/);
	assert.match(pipCalls[1]!, / torch transformers==4\.51\.3 diffusers accelerate numpy tqdm$/);
	assert.doesNotMatch(pipCalls.join("\n"), /gradio|aiortc|librosa|fastapi/);
	assert.equal(existsSync(join(target, ".download-cache")), false);
	assert.equal(formatInstallView(createInstallChecklist().snapshot()).some((line) => line.includes("Existing components")), false);
});

test("a clean install fetches model config before the engine probe", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const config = artifact("model-config", "models/VibeVoice-Realtime-0.5B/config.json", "{\"ok\":true}");
	const preprocessor = artifact("model-preprocessor", "models/VibeVoice-Realtime-0.5B/preprocessor_config.json", "{\"pre\":1}");
	const full = [...artifacts, config, preprocessor];
	bodies.set("model-config", "{\"ok\":true}");
	bodies.set("model-preprocessor", "{\"pre\":1}");
	const calls: string[] = [];
	let configPresentAtProbe = false;
	let stepsAtEnd: { id: string; state: string }[] = [];
	const io = fakeIo(bodies, calls);
	const baseFetch = io.fetch.bind(io);
	io.fetch = async (item, destination, signal) => {
		await baseFetch(item, destination, signal);
		if (item.id === "code-license") {
			const voicePath = join(target, "voices/sp-Spk0_woman.pt");
			mkdirSync(join(target, "voices"), { recursive: true });
			writeFileSync(voicePath, "voice-ok");
		}
	};
	io.probeWorker = async () => {
		configPresentAtProbe = readFileSync(join(target, "models/VibeVoice-Realtime-0.5B/config.json"), "utf8") === "{\"ok\":true}";
		return { code: 0 };
	};
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io,
		artifacts: full,
		onProgress: (event) => {
			stepsAtEnd = event.steps.map((step) => ({ id: step.id, state: step.state }));
		},
	});
	assert.equal(result.status, "installed");
	assert.equal(configPresentAtProbe, true);
	assert.equal(calls.includes("fetch:model-config"), true);
	assert.equal(calls.includes("fetch:model-preprocessor"), true);
	assert.equal(calls.indexOf("fetch:model-config") < calls.indexOf("fetch:code-license"), true);
	assert.equal(stepsAtEnd.find((step) => step.id === "spanish")?.state, "completed");
	assert.equal(stepsAtEnd.some((step) => step.id === "components"), false);
});

test("a pip failure keeps verified files and does not mark the engine installed", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, [], { fail: "pip" }),
		artifacts,
	});
	assert.equal(result.status, "partial");
	assert.equal(result.reason, "pip_failed");
	assert.match(result.detail ?? "", /pip stopped/);
	assert.throws(() => readFileSync(join(target, "INSTALL_PENDING.json")));
	assert.equal(readFileSync(join(target, "models/VibeVoice-Realtime-0.5B/model.safetensors"), "utf8"), "weights-ok");
	assert.equal(readTtsEnginePreference(voiceHome), "unset");
});

test("a worker probe failure is not marked installed", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const io = fakeIo(bodies, []);
	io.probeWorker = async () => ({ code: 4, detail: "probe_deps_missing" });
	let engineState = "";
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io,
		artifacts,
		onProgress: (event) => {
			engineState = event.steps.find((step) => step.id === "engine")?.state ?? engineState;
		},
	});
	assert.equal(result.status, "partial");
	assert.equal(result.reason, "worker_probe_failed");
	assert.equal(engineState, "failed");
	assert.throws(() => readFileSync(join(target, "INSTALL_PENDING.json")));
	assert.equal(readTtsEnginePreference(voiceHome), "unset");
});

test("an interrupted install resumes without fetching a verified weight file", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const weights = artifacts.find((item) => item.id === "weights")!;
	mkdirSync(join(target, "models/VibeVoice-Realtime-0.5B"), { recursive: true });
	writeFileSync(join(target, weights.relativePath), bodies.get("weights")!);
	mkdirSync(join(target, ".venv/bin"), { recursive: true });
	const calls: string[] = [];
	let weightState = "";
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, calls),
		artifacts,
		onProgress: (event) => {
			weightState = event.steps.find((step) => step.id === "weights")?.state ?? weightState;
		},
	});
	assert.equal(result.status, "installed");
	assert.equal(calls.filter((call) => call === "fetch:weights").length, 0);
	assert.equal(weightState, "reused");
	assert.equal(calls.some((call) => slash(call).includes("/.venv/bin/pip install")), true);
});

test("cancelling during pip leaves the install unmarked", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const abort = new AbortController();
	const io = fakeIo(bodies, []);
	const original = io.run.bind(io);
	io.run = async (command, args, signal) => {
		if (slash(command).endsWith("/.venv/bin/pip")) {
			abort.abort();
			throw new Error("cancelled");
		}
		return original(command, args, signal);
	};
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		signal: abort.signal,
		io,
		artifacts,
	});
	assert.equal(result.status, "cancelled");
	assert.equal(result.reason, "cancelled");
	assert.throws(() => readFileSync(join(target, "INSTALL_PENDING.json")));
	assert.equal(readFileSync(join(target, "models/VibeVoice-Realtime-0.5B/model.safetensors"), "utf8"), "weights-ok");
});

test("a dependency check that still fails after pip is not marked installed", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	const io = fakeIo(bodies, calls);
	const original = io.run.bind(io);
	io.run = async (command, args, signal) => {
		if (args.some((arg) => arg.includes("importlib.metadata"))) return { code: 4, detail: "vibevoice metadata missing" };
		return original(command, args, signal);
	};
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io,
		artifacts,
	});
	assert.equal(result.status, "partial");
	assert.equal(result.reason, "verify_failed");
	assert.throws(() => readFileSync(join(target, "INSTALL_PENDING.json")));
});

test("a corrupt download is rejected and a retry skips the verified file", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	const corrupt = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, calls, { corrupt: "spanish-voice" }),
		artifacts,
	});
	assert.equal(corrupt.status, "corrupt");
	assert.equal(readTtsEnginePreference(voiceHome), "unset");
	const again = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, calls),
		artifacts,
	});
	assert.equal(again.status, "installed");
	assert.equal(calls.filter((call) => call === "fetch:weights").length, 1);
	assert.equal(calls.filter((call) => call === "fetch:spanish-voice").length, 2);
});

test("cancellation and a failed step leave the install unmarked", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	const aborted = new AbortController();
	aborted.abort();
	const cancelled = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		signal: aborted.signal,
		io: fakeIo(bodies, calls),
		artifacts,
	});
	assert.equal(cancelled.status, "cancelled");
	assert.equal(calls.length, 0);
	const partial = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, calls, { fail: "spanish-voice" }),
		artifacts,
	});
	assert.equal(partial.status, "partial");
	assert.equal(readTtsEnginePreference(voiceHome), "unset");
	assert.throws(() => readFileSync(join(target, "INSTALL_PENDING.json")));
});

test("an existing engine is reused and an explicit Piper choice is kept", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	writeTtsEnginePreference(voiceHome, "piper");
	const kept = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: true,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, calls),
		artifacts,
	});
	assert.equal(kept.status, "kept_piper");
	assert.equal(calls.length, 0);
	writeTtsEnginePreference(voiceHome, "vibevoice");
	const reused = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware: { nvidiaPresent: false, freeDiskMb: 1 },
		alreadyInstalled: true,
		consent: false,
		allowNetwork: false,
		artifacts,
	});
	assert.equal(reused.status, "reused");
	assert.equal(reused.engine, "vibevoice");
});

test("uninstall removes only the receipt-backed files", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, []),
		artifacts,
	});
	const foreign = join(target, "notes.txt");
	writeFileSync(foreign, "mine");
	const refused = await uninstallVibeVoiceEngine({ targetDir: target, artifacts });
	assert.equal(refused.deleted, false);
	const removed = await uninstallVibeVoiceEngine({
		targetDir: target,
		confirmToken: "UNINSTALL_VIBEVOICE",
		artifacts,
	});
	assert.equal(removed.deleted, true);
	assert.equal(readFileSync(foreign, "utf8"), "mine");
	assert.throws(() => readFileSync(join(target, "models/VibeVoice-Realtime-0.5B/model.safetensors")));
});

test("explicit Piper wins over a ready VibeVoice directory", () => {
	const voiceHome = mkdtempSync(join(tmpdir(), "gv-tts-pref-"));
	const prevHome = process.env.GENTLE_VOICE_VIBEVOICE_HOME;
	const prevVoice = process.env.GENTLE_VOICE_HOME;
	const prevTts = process.env.GENTLE_VOICE_TTS;
	try {
		process.env.GENTLE_VOICE_HOME = voiceHome;
		process.env.GENTLE_VOICE_TTS = "piper";
		const resolved = resolveLabVoiceAdapters({ forceStub: false });
		assert.notEqual(resolved.ttsKind, "vibevoice");
		assert.equal(chooseTtsEngine({ preference: "vibevoice", vibevoiceReady: false, kokoroReady: false }), "piper");
		assert.equal(chooseTtsEngine({ preference: "vibevoice", vibevoiceReady: true, kokoroReady: false }), "vibevoice");
		assert.equal(chooseTtsEngine({ preference: undefined, vibevoiceReady: true, kokoroReady: false }), "vibevoice");
		assert.equal(chooseTtsEngine({ preference: undefined, vibevoiceReady: false, kokoroReady: false }), "piper");
		assert.equal(resolvePreferredTts({ GENTLE_VOICE_TTS: "piper", GENTLE_VOICE_HOME: voiceHome }), "piper");
	} finally {
		if (prevHome === undefined) delete process.env.GENTLE_VOICE_VIBEVOICE_HOME;
		else process.env.GENTLE_VOICE_VIBEVOICE_HOME = prevHome;
		if (prevVoice === undefined) delete process.env.GENTLE_VOICE_HOME;
		else process.env.GENTLE_VOICE_HOME = prevVoice;
		if (prevTts === undefined) delete process.env.GENTLE_VOICE_TTS;
		else process.env.GENTLE_VOICE_TTS = prevTts;
	}
});

test("tar listing accepts GNU and BSD verbose rows", () => {
	const gnu = parseTarListing("-rw-r--r-- runner/runner 4 2026-10-21 16:04 sp/sp-Spk2_woman.pt\n");
	assert.deepEqual(gnu, [{ type: "-", name: "sp/sp-Spk2_woman.pt" }]);
	const bsd = parseTarListing([
		"-rw-r--r--  0 runner staff 4 Oct 21 16:04 2026 sp/sp-Spk2_woman.pt",
		"lrwxr-xr-x  0 runner staff 0 Oct 21 16:04 2026 sp-Spk0_woman.pt -> /etc/passwd",
		"-rw-r--r--  0 runner staff 4 Apr 21  2020 old-voice.pt",
	].join("\n"));
	assert.equal(bsd[0]?.name, "sp/sp-Spk2_woman.pt");
	assert.equal(bsd[1]?.type, "l");
	assert.equal(bsd[1]?.name, "sp-Spk0_woman.pt");
	assert.equal(bsd[2]?.name, "old-voice.pt");
});

test("tar extraction ignores members that climb out of the archive", async () => {
	const root = mkdtempSync(join(tmpdir(), "gv-tar-"));
	const src = join(root, "src");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "sp-Spk0_woman.pt"), "voice-bytes");
	const archive = join(root, "voices.tgz");
	const packed = spawnSync("tar", ["-czf", archive, "-C", root, "src/sp-Spk0_woman.pt"], { encoding: "utf8" });
	assert.equal(packed.status, 0, packed.stderr);
	const dest = join(root, "out", "sp-Spk0_woman.pt");
	await extractTarMember(archive, "sp-Spk0_woman.pt", dest);
	assert.equal(readFileSync(dest, "utf8"), "voice-bytes");
	const evil = join(root, "evil.tgz");
	const made = spawnSync("python3", ["-c", `
import tarfile
from pathlib import Path
root = Path(${JSON.stringify(root)})
payload = root / "payload"
payload.write_text("nope")
with tarfile.open(root / "evil.tgz", "w:gz") as tar:
    tar.add(payload, arcname="../passwd")
`], { encoding: "utf8" });
	assert.equal(made.status, 0, made.stderr);
	await assert.rejects(() => extractTarMember(evil, "passwd", join(root, "passwd")));
});

test("the experimental Spanish archive shape has no sp-Spk0_woman.pt", async () => {
	const root = mkdtempSync(join(tmpdir(), "gv-tar-real-"));
	const archive = join(root, "experimental_voices_sp.tar.gz");
	const made = spawnSync("python3", ["-c", `
import tarfile
from pathlib import Path
root = Path(${JSON.stringify(root)})
with tarfile.open(root / "experimental_voices_sp.tar.gz", "w:gz") as tar:
    for name in ("sp-Spk2_woman.pt", "sp-Spk3_man.pt", "sp-Spk4_woman.pt", "sp-Spk5_man.pt"):
        payload = root / name
        payload.write_bytes(b"x")
        tar.add(payload, arcname=f"sp/{name}")
`], { encoding: "utf8" });
	assert.equal(made.status, 0, made.stderr);
	await assert.rejects(
		() => extractTarMember(archive, "sp-Spk0_woman.pt", join(root, "out.pt")),
		/archive_member_missing:sp-Spk0_woman\.pt:.*sp\/sp-Spk2_woman\.pt/,
	);
	const nested = join(root, "sp-Spk2_woman.pt");
	await extractTarMember(archive, { basename: "sp-Spk2_woman.pt", pathSuffix: "sp/sp-Spk2_woman.pt" }, nested);
	assert.equal(readFileSync(nested, "utf8"), "x");
});

test("a code-archive voice path is extracted and a symlink member is refused", async () => {
	const root = mkdtempSync(join(tmpdir(), "gv-tar-code-"));
	const archive = join(root, "code.tar.gz");
	const made = spawnSync("python3", ["-c", `
import tarfile
from pathlib import Path
root = Path(${JSON.stringify(root)})
voice = root / "voice.pt"
voice.write_text("spk0")
with tarfile.open(root / "code.tar.gz", "w:gz") as tar:
    tar.add(voice, arcname="VibeVoice-test/demo/voices/streaming_model/sp-Spk0_woman.pt")
link = root / "link.tar.gz"
with tarfile.open(link, "w:gz") as tar:
    info = tarfile.TarInfo("sp-Spk0_woman.pt")
    info.type = tarfile.SYMTYPE
    info.linkname = "/etc/passwd"
    tar.addfile(info)
`], { encoding: "utf8" });
	assert.equal(made.status, 0, made.stderr);
	const dest = join(root, "out", "sp-Spk0_woman.pt");
	await extractTarMember(archive, {
		basename: "sp-Spk0_woman.pt",
		pathSuffix: "demo/voices/streaming_model/sp-Spk0_woman.pt",
	}, dest);
	assert.equal(readFileSync(dest, "utf8"), "spk0");
	await assert.rejects(
		() => extractTarMember(join(root, "link.tar.gz"), "sp-Spk0_woman.pt", join(root, "linked.pt")),
		/archive_symlink/,
	);
});

test("PyTorch wheel range accepts 3.10 through 3.14 and rejects 3.15", () => {
	assert.equal(vibeVoicePythonSupported("GVPY 3.14"), true);
	assert.equal(vibeVoicePythonSupported("GVPY 3.10"), true);
	assert.equal(vibeVoicePythonSupported("GVPY 3.15"), false);
	assert.equal(vibeVoicePythonSupported("3.14"), false);
});

test("an existing Python 3.15 venv is replaced by Python 3.14", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	mkdirSync(join(target, ".venv/bin"), { recursive: true });
	writeFileSync(join(target, ".venv/OLD"), "stale");
	writeFileSync(join(target, ".venv/bin/python"), "#!/bin/sh\n");
	writeFileSync(join(target, ".venv/bin/pip"), "#!/bin/sh\n");
	const io = fakeIo(bodies, calls);
	const original = io.run.bind(io);
	let readyChecks = 0;
	io.run = async (command, args, signal) => {
		if (command === "python3" && String(args[1] ?? "").includes("GVPY")) {
			return { code: 0, detail: "GVPY 3.15" };
		}
		if (slash(command).endsWith("/.venv/bin/python") && String(args[1] ?? "").includes("version_info")) {
			readyChecks += 1;
			if (readyChecks === 1) return { code: 3, detail: "GVPY 3.15" };
		}
		return original(command, args, signal!);
	};
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io,
		artifacts,
	});
	assert.equal(result.status, "installed");
	assert.equal(calls.some((call) => call.startsWith("python3.14 -m venv ")), true);
	assert.equal(calls.some((call) => call.startsWith("python3 -m venv ")), false);
	assert.throws(() => readFileSync(join(target, ".venv/OLD")));
});
