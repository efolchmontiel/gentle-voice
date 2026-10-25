/**
 * Resolve VAD backend: Silero when available, else energy (fail-closed).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createEnergyVad, type EnergyVadOptions } from "./energy-vad.ts";
import { readSileroDeclined, sileroModelPath, sileroPreferencePath } from "./silero-install.ts";
import { tryCreateSileroVad, type SileroVadOptions } from "./silero-vad.ts";
import type { VadBackendId, VadEngine } from "./types.ts";

export type VadBackendPreference = "energy" | "silero" | "auto";

export interface ResolveVadInput {
	readonly preference?: VadBackendPreference;
	readonly energy?: EnergyVadOptions;
	readonly silero?: Partial<SileroVadOptions> & { modelPath?: string };
	/** Env — GENTLE_VOICE_VAD=energy|silero|auto, GENTLE_VOICE_SILERO_VAD=path */
	readonly env?: NodeJS.ProcessEnv;
}

export interface ResolvedVad {
	readonly engine: VadEngine;
	readonly backend: VadBackendId;
	readonly fallbackReason?: string;
}

function preferenceFromEnv(env: NodeJS.ProcessEnv): VadBackendPreference | undefined {
	const raw = env.GENTLE_VOICE_VAD?.trim().toLowerCase();
	if (raw === "energy" || raw === "silero" || raw === "auto") return raw;
	return undefined;
}

/**
 * Model path resolution (no machine-specific hardcodes):
 * 1. explicit silero.modelPath
 * 2. GENTLE_VOICE_SILERO_VAD
 * 3. $GENTLE_VOICE_MODELS/silero/silero_vad.onnx (lab convention)
 *
 * Uses the same `env` object as preferenceFromEnv (input.env ?? process.env).
 * Previously only read input.env — PipeWire capture omits env, so process.env
 * was ignored and real GS-Lab sessions always fell back with silero_model_path_missing.
 */
export function modelPathFrom(input: ResolveVadInput, env: NodeJS.ProcessEnv): string {
	const fromOpt = input.silero?.modelPath?.trim();
	if (fromOpt) return fromOpt;
	const fromEnv = env.GENTLE_VOICE_SILERO_VAD?.trim();
	if (fromEnv) return fromEnv;
	const modelsRoot = env.GENTLE_VOICE_MODELS?.trim();
	if (modelsRoot) return join(modelsRoot, "silero", "silero_vad.onnx");
	// Same directory the onboarding installer writes. Skip when HOME is absent
	// so a unit test with env {} cannot see the developer's real install.
	if (env.GENTLE_VOICE_HOME?.trim() || env.HOME?.trim()) {
		const installed = sileroModelPath(env);
		if (existsSync(installed)) return installed;
	}
	return "";
}

/**
 * Async resolve. Prefer calling once per capture adapter construction / listen start.
 */
export async function resolveVad(input: ResolveVadInput = {}): Promise<ResolvedVad> {
	const env = input.env ?? process.env;
	const preference = input.preference ?? preferenceFromEnv(env) ?? "auto";
	const energyOpts: EnergyVadOptions = { ...(input.energy ?? {}) };
	const energy = (): ResolvedVad => ({
		engine: createEnergyVad(energyOpts),
		backend: "energy",
	});

	if (preference === "energy") {
		return energy();
	}
	// A recorded decline is energy on purpose. Do not warn on every listen.
	if (preference === "auto" && readSileroDeclined(sileroPreferencePath(env))) {
		return energy();
	}

	const modelPath = modelPathFrom(input, env);
	const sileroOpts: SileroVadOptions = {
		...input.silero,
		env,
		modelPath,
		sampleRateHz: input.silero?.sampleRateHz ?? energyOpts.sampleRateHz ?? 16_000,
		silenceHangMs: input.silero?.silenceHangMs ?? 900,
		maxIntraPauseMs: input.silero?.maxIntraPauseMs ?? energyOpts.maxIntraPauseMs ?? 350,
		postRollMs: input.silero?.postRollMs ?? 150,
		maxListenMs: input.silero?.maxListenMs ?? energyOpts.maxListenMs,
		speechProbThreshold: input.silero?.speechProbThreshold,
		runFrame: input.silero?.runFrame,
	};

	const loaded = await tryCreateSileroVad(sileroOpts);
	if (loaded.ok) {
		return { engine: loaded.engine, backend: "silero" };
	}

	if (preference === "silero") {
		// Explicit silero requested but unavailable — still fail soft to energy.
		return { ...energy(), fallbackReason: loaded.reason };
	}

	// auto
	return { ...energy(), fallbackReason: loaded.reason };
}

/** Sync energy-only helper (tests / when Silero not considered). */
export function resolveEnergyVadOnly(options: EnergyVadOptions = {}): ResolvedVad {
	return { engine: createEnergyVad(options), backend: "energy" };
}
