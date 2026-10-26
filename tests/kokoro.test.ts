import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKokoroWorkerTtsAdapter } from "../lib/adapters/kokoro-worker-tts.ts";
import { runKokoroInstall, kokoroBasePythonAvailable, type KokoroInstallIo } from "../lib/kokoro/install.ts";
import { KOKORO_ARTIFACTS, KOKORO_PIP_REQUIREMENTS, type KokoroArtifact } from "../lib/kokoro/manifest.ts";
import {
	ENGINE_KOKORO,
	GPU_PREMIUM_LABEL,
	RECOMMENDED_FOR_SYSTEM,
	VOICE_QUALITY_LABEL,
	followEngineSelection,
	parseEngineChoice,
	recommendTts,
	voiceEngineOptions,
} from "../lib/runtime/onboarding-choice.ts";
import {
	chooseTtsEngine,
	readTtsEnginePreference,
	writeTtsEnginePreference,
} from "../lib/vibevoice/tts-preference.ts";

function scratch(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

test("Kokoro artifacts are pinned by size and sha256", () => {
	assert.deepEqual(KOKORO_ARTIFACTS.map((a) => a.id), ["model", "voices"]);
	for (const artifact of KOKORO_ARTIFACTS) {
		assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
		assert.ok(artifact.bytes > 1_000_000);
		assert.match(artifact.origin, /^https:\/\/github\.com\/thewh1teagle\/kokoro-onnx\/releases\/download\//);
	}
	assert.deepEqual([...KOKORO_PIP_REQUIREMENTS], ["kokoro-onnx==0.6.1"]);
});

test("engine choice: VibeVoice first when ready, then Kokoro, then Piper", () => {
	assert.equal(chooseTtsEngine({ vibevoiceReady: true, kokoroReady: true }), "vibevoice");
	assert.equal(chooseTtsEngine({ vibevoiceReady: false, kokoroReady: true }), "kokoro");
	assert.equal(chooseTtsEngine({ vibevoiceReady: false, kokoroReady: false }), "piper");
	assert.equal(chooseTtsEngine({ preference: "kokoro", vibevoiceReady: true, kokoroReady: true }), "kokoro");
	assert.equal(chooseTtsEngine({ preference: "kokoro", vibevoiceReady: true, kokoroReady: false }), "piper");
	assert.equal(chooseTtsEngine({ preference: "vibevoice", vibevoiceReady: false, kokoroReady: true }), "kokoro");
	assert.equal(chooseTtsEngine({ preference: "piper", vibevoiceReady: true, kokoroReady: true }), "piper");
});

test("a stored kokoro preference round-trips", () => {
	const home = scratch("gv-kokoro-pref-");
	try {
		writeTtsEnginePreference(home, "kokoro");
		assert.equal(readTtsEnginePreference(home), "kokoro");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the menu recommends a runnable Kokoro and keeps VibeVoice as the GPU option", () => {
	const menu = voiceEngineOptions("supported", true, { runnable: true, installed: false });
	assert.equal(menu.recommended, "kokoro");
	assert.equal(menu.options[0], `${ENGINE_KOKORO}  ${VOICE_QUALITY_LABEL.kokoro}  ${RECOMMENDED_FOR_SYSTEM}`);
	assert.equal(menu.options[1]?.endsWith(GPU_PREMIUM_LABEL), true);
	assert.equal(menu.options.filter((o) => o.includes(RECOMMENDED_FOR_SYSTEM)).length, 1);
	assert.equal(parseEngineChoice(menu.options[0]), "kokoro");
	assert.equal(parseEngineChoice(menu.options[1]), "vibevoice");

	const legacy = voiceEngineOptions("supported", true, { runnable: false, installed: false });
	assert.equal(legacy.recommended, "vibevoice");
	assert.equal(legacy.options.some((o) => o.startsWith(ENGINE_KOKORO)), false);
});

test("choosing Kokoro activates an install or asks before downloading", () => {
	const base = {
		compatibility: "unsupported" as const,
		compatibilityReasons: ["gpu_required"],
		installBlocked: true,
		blockReasons: ["gpu_required"],
		installState: "missing" as const,
		piperPresent: false,
		location: "/x",
		consentBody: "Kokoro consent",
	};
	assert.deepEqual(followEngineSelection({ ...base, choice: "kokoro", kokoroInstalled: true }), {
		kind: "activate",
		engine: "kokoro",
		notice: "Kokoro: Installed.",
	});
	assert.deepEqual(followEngineSelection({ ...base, choice: "kokoro", kokoroInstalled: false }), {
		kind: "confirm",
		engine: "kokoro",
		title: "Install Kokoro?",
		message: "Kokoro consent",
	});
});

test("an installed Kokoro preference is kept even when VibeVoice is ready", () => {
	const rec = recommendTts({
		preference: "kokoro",
		recommendationDeclined: false,
		compatibility: "supported",
		compatibilityReasons: [],
		piperRunnable: true,
		installState: "installed",
		installBlocked: false,
		blockReasons: [],
		location: "/x",
		consentBody: "",
		kokoro: { runnable: true, installed: true },
	});
	assert.equal(rec.action, "keep");
	assert.equal(rec.recommended, "kokoro");
});

test("the base Python check accepts 3.11 to 3.14 only", () => {
	assert.equal(kokoroBasePythonAvailable(() => "GVPY 3.14\n"), true);
	assert.equal(kokoroBasePythonAvailable(() => "GVPY 3.10\n"), false);
	assert.equal(kokoroBasePythonAvailable(() => "GVPY 3.15\n"), false);
	assert.equal(kokoroBasePythonAvailable(() => undefined), false);
});

function fakeArtifacts(): { artifacts: KokoroArtifact[]; bodies: Map<string, Buffer> } {
	const bodies = new Map<string, Buffer>();
	const artifacts = KOKORO_ARTIFACTS.map((real) => {
		const body = Buffer.from(`fake ${real.id}`);
		bodies.set(real.origin, body);
		return { ...real, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
	});
	return { artifacts, bodies };
}

function fakeIo(bodies: Map<string, Buffer>, python = "GVPY 3.14") {
	const calls: string[] = [];
	const fetched: string[] = [];
	const io: KokoroInstallIo = {
		async fetch(url, destination) {
			fetched.push(url);
			await writeFile(destination, bodies.get(url) ?? Buffer.from("wrong"));
		},
		async run(command, args) {
			calls.push([command, ...args].join(" "));
			if (args.includes("-c")) return { code: 0, detail: python };
			return { code: 0 };
		},
	};
	return { io, calls, fetched };
}

test("install downloads verified files, uses a cache-free pip, and saves kokoro", async () => {
	const root = scratch("gv-kokoro-install-");
	try {
		const { artifacts, bodies } = fakeArtifacts();
		const { io, calls, fetched } = fakeIo(bodies);
		const progress: string[] = [];
		const result = await runKokoroInstall({
			targetDir: join(root, "kokoro"),
			voiceHome: join(root, "home"),
			consent: true,
			io,
			artifacts,
			onProgress: (m) => progress.push(m),
		});
		assert.equal(result.status, "installed", result.detail ?? result.reason);
		assert.deepEqual(result.fetched, ["model", "voices"]);
		assert.equal(fetched.length, 2);
		const pip = calls.find((c) => c.includes(" pip install "));
		assert.ok(pip);
		assert.match(pip, / --no-cache-dir /);
		assert.match(pip, / --ignore-requires-python kokoro-onnx==0\.6\.1$/);
		assert.ok(calls.some((c) => c.includes(" -m venv ")));
		assert.ok(calls.some((c) => c.endsWith(" --probe")));
		assert.equal(calls.some((c) => c.startsWith("sudo")), false);
		assert.ok(existsSync(join(root, "kokoro", "integrity.json")));
		assert.equal(readTtsEnginePreference(join(root, "home")), "kokoro");
		assert.ok(progress.includes("Installing Kokoro"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a download that does not match its pin is deleted and reported corrupt", async () => {
	const root = scratch("gv-kokoro-corrupt-");
	try {
		const { artifacts } = fakeArtifacts();
		const { io, calls } = fakeIo(new Map());
		const result = await runKokoroInstall({
			targetDir: join(root, "kokoro"),
			voiceHome: join(root, "home"),
			consent: true,
			io,
			artifacts,
		});
		assert.equal(result.status, "corrupt");
		assert.equal(existsSync(join(root, "kokoro", "models", "kokoro-v1.0.fp16.onnx.partial")), false);
		assert.equal(calls.length, 0);
		assert.equal(readTtsEnginePreference(join(root, "home")), "unset");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("install without consent downloads nothing", async () => {
	const root = scratch("gv-kokoro-consent-");
	try {
		const { artifacts, bodies } = fakeArtifacts();
		for (const consent of [false, undefined]) {
			const { io, fetched } = fakeIo(bodies);
			const result = await runKokoroInstall({ targetDir: join(root, "k"), voiceHome: root, consent, io, artifacts });
			assert.equal(result.status, consent === false ? "declined" : "consent_unavailable");
			assert.equal(fetched.length, 0);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("install stops when no Python 3.11-3.14 exists", async () => {
	const root = scratch("gv-kokoro-python-");
	try {
		const { artifacts, bodies } = fakeArtifacts();
		const { io, calls } = fakeIo(bodies, "GVPY 3.10");
		const result = await runKokoroInstall({ targetDir: join(root, "k"), voiceHome: root, consent: true, io, artifacts });
		assert.equal(result.status, "failed");
		assert.equal(result.reason, "python_unsupported");
		assert.equal(calls.some((c) => c.includes(" pip ")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const FAKE_WORKER = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const crashOn = process.env.FAKE_KOKORO_CRASH_ON ?? "";
function wav() {
	const data = Buffer.alloc(4);
	const h = Buffer.alloc(44);
	h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
	h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
	h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
	h.write("data", 36); h.writeUInt32LE(data.length, 40);
	return Buffer.concat([h, data]);
}
process.stdout.write(JSON.stringify({ op: "ready" }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const req = JSON.parse(line);
	if (crashOn && req.text === crashOn) process.exit(3);
	if (req.text === "slow") return;
	writeFileSync(req.out, wav());
	process.stdout.write(JSON.stringify({ op: "done", id: req.id, sampleRate: 24000 }) + "\\n");
});
`;

function fakeWorkerAdapter(root: string, env: NodeJS.ProcessEnv = {}) {
	const script = join(root, "worker.mjs");
	writeFileSync(script, FAKE_WORKER);
	let spawns = 0;
	const adapter = createKokoroWorkerTtsAdapter({
		python: process.execPath,
		script,
		home: root,
		tmpDir: join(root, "tmp"),
		startupTimeoutMs: 10_000,
		requestTimeoutMs: 10_000,
		spawnWorker: (command, args) => {
			spawns += 1;
			return spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
		},
	});
	return { adapter, spawns: () => spawns };
}

test("the worker adapter reuses one process and returns a WAV", async () => {
	const root = scratch("gv-kokoro-adapter-");
	const { adapter, spawns } = fakeWorkerAdapter(root);
	try {
		assert.equal((await adapter.availability()).status, "ready");
		const first = await adapter.synthesize("hola", { signal: new AbortController().signal });
		const second = await adapter.synthesize("chau", { signal: new AbortController().signal });
		assert.equal(first.audio?.format, "wav");
		assert.equal(first.audio?.sampleRateHz, 24000);
		assert.equal(second.audio?.format, "wav");
		assert.equal(spawns(), 1);
		assert.equal((await adapter.synthesize("   ", { signal: new AbortController().signal })).audio?.bytes.length ?? 0, 0);
	} finally {
		await adapter.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("abort rejects the pending request without killing the worker", async () => {
	const root = scratch("gv-kokoro-abort-");
	const { adapter, spawns } = fakeWorkerAdapter(root);
	try {
		const controller = new AbortController();
		const pending = adapter.synthesize("slow", { signal: controller.signal });
		setTimeout(() => controller.abort(), 200);
		await assert.rejects(pending, (error: Error) => error.name === "AbortError");
		const next = await adapter.synthesize("hola", { signal: new AbortController().signal });
		assert.equal(next.audio?.format, "wav");
		assert.equal(spawns(), 1);
	} finally {
		await adapter.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a crashed worker fails the request and the next call restarts it", async () => {
	const root = scratch("gv-kokoro-crash-");
	const { adapter, spawns } = fakeWorkerAdapter(root, { FAKE_KOKORO_CRASH_ON: "boom" });
	try {
		await assert.rejects(
			adapter.synthesize("boom", { signal: new AbortController().signal }),
			/kokoro worker exited \(code=3/,
		);
		const next = await adapter.synthesize("hola", { signal: new AbortController().signal });
		assert.equal(next.audio?.format, "wav");
		assert.equal(spawns(), 2);
	} finally {
		await adapter.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
