/**
 * Integration: launcher-like env must reach resolveVad the same way PipeWire capture does
 * (preference set, no explicit silero.modelPath, env omitted → process.env).
 *
 * Regression for silero_model_path_missing in real GS-Lab sessions.
 */
import assert from "node:assert/strict";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { modelPathFrom, resolveVad } from "../lib/vad/resolve-vad.ts";
import { resolveSherpaRuntime } from "../lib/vad/sherpa-runtime.ts";

const LAB_MODELS =
	process.env.GENTLE_VOICE_MODELS?.trim()
	|| "/home/erickfm/WD-Black/gentle-voice/models";
const LAB_SILERO =
	process.env.GENTLE_VOICE_SILERO_VAD?.trim()
	|| join(LAB_MODELS, "silero", "silero_vad.onnx");

async function modelReadable(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

test("modelPathFrom uses process.env when input.env omitted (capture call site)", () => {
	const prev = process.env.GENTLE_VOICE_SILERO_VAD;
	process.env.GENTLE_VOICE_SILERO_VAD = "/tmp/launcher-propagated-silero.onnx";
	try {
		// PipeWire historically called resolveVad without `env` and with no modelPath.
		const path = modelPathFrom({ preference: "auto", silero: {} }, process.env);
		assert.equal(path, "/tmp/launcher-propagated-silero.onnx");
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_SILERO_VAD;
		else process.env.GENTLE_VOICE_SILERO_VAD = prev;
	}
});

test("modelPathFrom falls back to MODELS/silero/silero_vad.onnx (no WD-Black hardcode)", () => {
	const path = modelPathFrom(
		{ preference: "auto", silero: {} },
		{ GENTLE_VOICE_MODELS: "/portable/models" },
	);
	assert.equal(path, join("/portable/models", "silero", "silero_vad.onnx"));
});

test("resolveVad capture-shaped call does NOT report silero_model_path_missing when env has path", async () => {
	const prevSilero = process.env.GENTLE_VOICE_SILERO_VAD;
	const prevVad = process.env.GENTLE_VOICE_VAD;
	process.env.GENTLE_VOICE_VAD = "auto";
	process.env.GENTLE_VOICE_SILERO_VAD = "/tmp/no-such-but-path-is-set.onnx";
	try {
		// Exact shape used by createPipewireCaptureAdapter (post-fix: env: process.env).
		const r = await resolveVad({
			preference: "auto",
			env: process.env,
			silero: {},
		});
		assert.equal(r.backend, "energy");
		assert.notEqual(r.fallbackReason, "silero_model_path_missing");
		assert.ok(r.fallbackReason);
		assert.match(r.fallbackReason, /unreadable|missing|ort/i);
	} finally {
		if (prevSilero === undefined) delete process.env.GENTLE_VOICE_SILERO_VAD;
		else process.env.GENTLE_VOICE_SILERO_VAD = prevSilero;
		if (prevVad === undefined) delete process.env.GENTLE_VOICE_VAD;
		else process.env.GENTLE_VOICE_VAD = prevVad;
	}
});

test("integration: launcher env loads real Silero (skip if model/runtime absent)", async (t) => {
	if (!(await modelReadable(LAB_SILERO))) {
		t.skip(`Silero model not readable at ${LAB_SILERO}`);
		return;
	}
	if (!resolveSherpaRuntime(process.env)) {
		t.skip("sherpa-onnx runtime not installed");
		return;
	}

	const prevSilero = process.env.GENTLE_VOICE_SILERO_VAD;
	const prevModels = process.env.GENTLE_VOICE_MODELS;
	const prevVad = process.env.GENTLE_VOICE_VAD;
	process.env.GENTLE_VOICE_VAD = "auto";
	process.env.GENTLE_VOICE_SILERO_VAD = LAB_SILERO;
	process.env.GENTLE_VOICE_MODELS = LAB_MODELS;

	try {
		// Capture-shaped: no explicit modelPath — must pick up launcher env.
		const r = await resolveVad({
			preference: "auto",
			env: process.env,
			silero: {},
		});
		assert.equal(
			r.backend,
			"silero",
			`expected silero, got ${r.backend} fallback=${r.fallbackReason ?? "(none)"}`,
		);
		assert.equal(r.fallbackReason, undefined);
	} finally {
		if (prevSilero === undefined) delete process.env.GENTLE_VOICE_SILERO_VAD;
		else process.env.GENTLE_VOICE_SILERO_VAD = prevSilero;
		if (prevModels === undefined) delete process.env.GENTLE_VOICE_MODELS;
		else process.env.GENTLE_VOICE_MODELS = prevModels;
		if (prevVad === undefined) delete process.env.GENTLE_VOICE_VAD;
		else process.env.GENTLE_VOICE_VAD = prevVad;
	}
});

test("integration: MODELS alone is enough when SILERO_VAD unset", async (t) => {
	if (!(await modelReadable(join(LAB_MODELS, "silero", "silero_vad.onnx")))) {
		t.skip("lab silero under MODELS not readable");
		return;
	}
	if (!resolveSherpaRuntime(process.env)) {
		t.skip("sherpa-onnx runtime not installed");
		return;
	}

	const prevSilero = process.env.GENTLE_VOICE_SILERO_VAD;
	const prevModels = process.env.GENTLE_VOICE_MODELS;
	delete process.env.GENTLE_VOICE_SILERO_VAD;
	process.env.GENTLE_VOICE_MODELS = LAB_MODELS;

	try {
		const r = await resolveVad({
			preference: "auto",
			env: process.env,
			silero: {},
		});
		assert.equal(
			r.backend,
			"silero",
			`MODELS convention failed: ${r.backend} ${r.fallbackReason ?? ""}`,
		);
	} finally {
		if (prevSilero === undefined) delete process.env.GENTLE_VOICE_SILERO_VAD;
		else process.env.GENTLE_VOICE_SILERO_VAD = prevSilero;
		if (prevModels === undefined) delete process.env.GENTLE_VOICE_MODELS;
		else process.env.GENTLE_VOICE_MODELS = prevModels;
	}
});
