/**
 * Phase 3 / 3.1 — portable paths, first-run plan, checksum, download helpers.
 * Network downloads only in explicit opt-in tests (skipped by default).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256Buffer, checksumMatches } from "../lib/runtime/checksum.ts";
import { resolveRuntimeLayout } from "../lib/runtime/paths.ts";
import { buildFirstRunPlan, verifyArtifactFile } from "../lib/runtime/first-run.ts";
import { VIBEVOICE_MODEL_SAFETENSORS_BYTES } from "../lib/adapters/vibevoice-tts.ts";
import { writeTtsEnginePreference } from "../lib/vibevoice/tts-preference.ts";
import { KOKORO_ARTIFACTS, KOKORO_INTEGRITY_KIND } from "../lib/kokoro/manifest.ts";
import { formatCompatMarkdown, COMPAT_MATRIX } from "../lib/runtime/compat-matrix.ts";
import { artifactsFor, detectArch } from "../lib/runtime/artifacts.ts";
import { parseVoiceArgs } from "../lib/commands.ts";
import { verifySha256 } from "../lib/runtime/download.ts";

/** Slash-normalize and drop Windows drive letters so `/tmp/...` asserts work on win32 CI. */
function posix(p: string): string {
	return p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
}

test("3 paths: linux XDG layout under HOME", () => {
	const layout = resolveRuntimeLayout(
		{
			HOME: "/tmp/gv-home-test",
			XDG_DATA_HOME: "/tmp/gv-home-test/.local/share",
			XDG_CONFIG_HOME: "/tmp/gv-home-test/.config",
			XDG_CACHE_HOME: "/tmp/gv-home-test/.cache",
		},
		"linux",
	);
	assert.equal(posix(layout.dataDir), "/tmp/gv-home-test/.local/share/gentle-voice");
	assert.equal(posix(layout.configDir), "/tmp/gv-home-test/.config/gentle-voice");
	assert.match(posix(layout.modelsDir), /models$/);
	assert.match(posix(layout.binDir), /bin$/);
});

test("3 paths: win32 LocalAppData", () => {
	const layout = resolveRuntimeLayout(
		{
			USERPROFILE: "C:\\Users\\test",
			LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
			APPDATA: "C:\\Users\\test\\AppData\\Roaming",
		},
		"win32",
	);
	assert.match(layout.dataDir.replace(/\\/g, "/"), /Local\/gentle-voice$/);
	assert.match(layout.configDir.replace(/\\/g, "/"), /Roaming\/gentle-voice$/);
});

test("3 paths: darwin Application Support", () => {
	const layout = resolveRuntimeLayout({ HOME: "/Users/test" }, "darwin");
	assert.equal(
		posix(layout.dataDir),
		"/Users/test/Library/Application Support/gentle-voice",
	);
	assert.match(posix(layout.cacheDir), /Caches\/gentle-voice$/);
});

test("3.1 artifacts: linux x64 catalog is fully pinned", () => {
	const arts = artifactsFor("linux", "x64");
	assert.ok(arts.length >= 5);
	for (const a of arts) {
		assert.ok(a.url, a.id);
		assert.equal(a.sha256.length, 64, a.id);
	}
});

test("3.1 first-run: isolated home reports needs_consent when artifacts missing", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-firstrun-"));
	const plan = await buildFirstRunPlan({
		GENTLE_VOICE_HOME: root,
		HOME: root,
	});
	assert.ok(plan.missing.length > 0);
	assert.equal(plan.status, "needs_consent");
	assert.ok(plan.estimatedDownloadBytes > 0);
});

test("3.1 a ready VibeVoice engine does not ask to download Piper", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-vv-ready-"));
	const engine = join(root, "vibevoice");
	const model = join(engine, "models", "VibeVoice-Realtime-0.5B");
	await mkdir(model, { recursive: true });
	await mkdir(join(engine, ".venv", "bin"), { recursive: true });
	await mkdir(join(engine, "voices"), { recursive: true });
	const weights = join(model, "model.safetensors");
	await writeFile(weights, "");
	truncateSync(weights, VIBEVOICE_MODEL_SAFETENSORS_BYTES);
	await writeFile(join(model, "config.json"), "{}");
	await writeFile(join(model, "preprocessor_config.json"), "{}");
	await writeFile(join(engine, ".venv", "bin", "python"), "");
	await writeFile(join(engine, "voices", "sp-Spk0_woman.pt"), "voice");
	await writeFile(join(engine, "INSTALL_PENDING.json"), JSON.stringify({ authorized: true, status: "installed" }));
	writeTtsEnginePreference(root, "vibevoice");
	for (const relative of [
		process.platform === "win32" ? "bin/whisper-cli.exe" : "bin/whisper-cli",
		"models/whisper/ggml-base-q5_1.bin",
	]) {
		const path = join(root, relative);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, "present");
	}
	const plan = await buildFirstRunPlan({
		GENTLE_VOICE_HOME: root,
		GENTLE_VOICE_VIBEVOICE_HOME: engine,
		HOME: root,
	});
	if (process.platform === "darwin") {
		assert.equal(plan.status, "partial");
		assert.match(plan.summary, /macOS/);
	} else {
		assert.equal(plan.status, "ready");
	}
	assert.equal(plan.missing.some((art) => art.id.startsWith("piper")), false);
	assert.equal(plan.summary.includes("Ready to download"), false);
});

test("3.1 a ready Kokoro engine does not ask to download Piper", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "gv-kokoro-ready-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const engine = join(root, "kokoro");
	await mkdir(join(engine, ".venv", "bin"), { recursive: true });
	await writeFile(join(engine, ".venv", "bin", "python"), "");
	await writeFile(join(engine, "integrity.json"), JSON.stringify({ kind: KOKORO_INTEGRITY_KIND }));
	for (const artifact of KOKORO_ARTIFACTS) {
		const path = join(engine, artifact.relativePath);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, "");
		truncateSync(path, artifact.bytes);
	}
	writeTtsEnginePreference(root, "kokoro");
	for (const relative of [
		process.platform === "win32" ? "bin/whisper-cli.exe" : "bin/whisper-cli",
		"models/whisper/ggml-base-q5_1.bin",
	]) {
		const path = join(root, relative);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, "present");
	}
	const plan = await buildFirstRunPlan({ GENTLE_VOICE_HOME: root, HOME: root });
	if (process.platform === "darwin") {
		assert.equal(plan.status, "partial");
	} else {
		assert.equal(plan.status, "ready");
		assert.match(plan.summary, /Kokoro/);
	}
	assert.equal(plan.missing.some((art) => art.id.startsWith("piper")), false);
	assert.equal(plan.summary.includes("Ready to download"), false);
});

test("3 checksum helpers", async () => {
	const hex = sha256Buffer(Buffer.from("gentle-voice"));
	assert.equal(hex.length, 64);
	assert.equal(checksumMatches(hex, hex.toUpperCase()), true);
	const root = await mkdtemp(join(tmpdir(), "gv-sha-"));
	const file = join(root, "x.bin");
	await writeFile(file, "abc");
	assert.equal(await verifyArtifactFile(file, ""), false);
	await verifySha256(file, sha256Buffer(Buffer.from("abc")));
});

test("3 compat matrix never marks win32/darwin conversation as supported", () => {
	for (const cell of COMPAT_MATRIX) {
		if (cell.platform === "win32" || cell.platform === "darwin") {
			assert.notEqual(cell.capture, "supported");
			assert.notEqual(cell.playback, "supported");
			assert.ok(cell.capture === "blocked" || cell.capture === "planned");
		}
	}
	assert.match(formatCompatMarkdown(), /linux/);
});

test("3 parseVoiceArgs setup", () => {
	assert.equal(parseVoiceArgs("setup").command, "setup");
});

test("3 first-run dirs created under private home only", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-layout-"));
	await mkdir(join(root, "models"), { recursive: true });
	const layout = resolveRuntimeLayout({ GENTLE_VOICE_HOME: root }, "linux");
	assert.equal(posix(layout.home), posix(root));
	assert.ok(posix(layout.modelsDir).startsWith(posix(root)));
});

test("3.2 paths: GENTLE_VOICE_HOME nests cache (ignores external lab CACHE)", () => {
	const root = "/tmp/gv-private-home";
	const layout = resolveRuntimeLayout(
		{
			GENTLE_VOICE_HOME: root,
			GENTLE_VOICE_CACHE: "/tmp/external-lab-cache/gentle-voice/cache",
			HOME: "/tmp/other",
		},
		"linux",
	);
	assert.equal(posix(layout.cacheDir), `${root}/cache`);
	assert.ok(!posix(layout.cacheDir).includes("external-lab-cache"));
});

test("3.1 detectArch", () => {
	assert.ok(["x64", "arm64", "other"].includes(detectArch()));
});
