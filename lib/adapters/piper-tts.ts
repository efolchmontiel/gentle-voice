/**
 * Piper TTS adapter — reuses an existing piper CLI + voice model by path.
 * Phase 2B: execute mode synthesizes real WAV (no LLM). Dry-run remains available.
 * Never moves/modifies Voxtype or system Piper installs.
 */

import { access, constants, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterAvailability, AudioChunk, TtsAdapter, TtsResult } from "../contracts.ts";
import { throwIfAborted } from "../process-cancel.ts";
import { runCaptured } from "./node-process.ts";
import { isWavBuffer } from "./wav.ts";

const EMPTY_PCM: AudioChunk = Object.freeze({
	bytes: new Uint8Array(0),
	sampleRateHz: 22_050,
	channels: 1,
	format: "wav" as const,
});

export interface PiperTtsPlan {
	readonly command: string;
	readonly args: readonly string[];
	readonly voiceModelPath: string;
	readonly voiceConfigPath: string;
	readonly dryRun: boolean;
}

export interface PiperMetrics {
	readonly synthesizeMs: number;
	readonly outputBytes: number;
	readonly sampleRateHz: number;
	readonly channels: number;
	readonly durationSec: number;
	readonly textChars: number;
}

export interface PiperTtsAdapterOptions {
	readonly piperPath: string;
	readonly voiceModelPath: string;
	/** Defaults to `${voiceModelPath}.json`. */
	readonly voiceConfigPath?: string;
	/**
	 * When true, synthesize() validates + records a plan and returns empty audio.
	 * Phase 2B lab sets dryRun: false.
	 */
	readonly dryRun?: boolean;
	readonly timeoutMs?: number;
	/** Override sample rate if voice JSON cannot be read (default 22050). */
	readonly sampleRateHz?: number;
	readonly tmpDir?: string;
	readonly keepTemp?: boolean;
}

export interface PiperTtsAdapter extends TtsAdapter {
	readonly lastPlan: PiperTtsPlan | undefined;
	readonly lastMetrics: PiperMetrics | undefined;
	buildPlan(text: string): PiperTtsPlan;
	readVoiceSampleRate(): Promise<number>;
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

function wavDurationSec(bytes: Uint8Array, sampleRateHz: number, channels: 1 | 2): number {
	const pcmBytes = isWavBuffer(bytes) ? Math.max(0, bytes.byteLength - 44) : bytes.byteLength;
	const samples = pcmBytes / 2 / channels;
	return samples / sampleRateHz;
}

export function createPiperTtsAdapter(options: PiperTtsAdapterOptions): PiperTtsAdapter {
	const dryRun = options.dryRun === true;
	const voiceConfigPath = options.voiceConfigPath ?? `${options.voiceModelPath}.json`;
	const tmpDir = options.tmpDir ?? join(tmpdir(), "gentle-voice");
	const keepTemp = options.keepTemp === true;
	let lastPlan: PiperTtsPlan | undefined;
	let lastMetrics: PiperMetrics | undefined;
	let cachedRate: number | undefined;

	const buildPlan = (wavOutPath: string): PiperTtsPlan => {
		// Piper writes WAV to -f path (stdout without -f is empty on this CLI build).
		const args = [
			"-m", options.voiceModelPath,
			"-c", voiceConfigPath,
			"-f", wavOutPath,
		];
		return {
			command: options.piperPath,
			args,
			voiceModelPath: options.voiceModelPath,
			voiceConfigPath,
			dryRun,
		};
	};

	const adapter: PiperTtsAdapter = {
		id: "piper-tts",
		get lastPlan() {
			return lastPlan;
		},
		get lastMetrics() {
			return lastMetrics;
		},
		buildPlan,
		async readVoiceSampleRate() {
			if (options.sampleRateHz && options.sampleRateHz > 0) return options.sampleRateHz;
			if (cachedRate) return cachedRate;
			try {
				const raw = await readFile(voiceConfigPath, "utf8");
				const json = JSON.parse(raw) as { audio?: { sample_rate?: number }; sample_rate?: number };
				const rate = json.audio?.sample_rate ?? json.sample_rate ?? 22_050;
				cachedRate = rate;
				return rate;
			} catch {
				cachedRate = 22_050;
				return 22_050;
			}
		},
		async availability(): Promise<AdapterAvailability> {
			if (!(await isExecutable(options.piperPath))) {
				return { status: "unavailable", reason: "piper_binary_missing" };
			}
			if (!(await isFile(options.voiceModelPath))) {
				return { status: "unavailable", reason: "piper_voice_missing" };
			}
			if (!(await isFile(voiceConfigPath))) {
				return {
					status: "degraded",
					reason: "piper_voice_json_missing",
					detail: voiceConfigPath,
				};
			}
			return {
				status: "ready",
				detail: dryRun ? "piper_ready_dry_run" : "piper_ready_execute",
			};
		},
		async synthesize(text, { signal }): Promise<TtsResult> {
			throwIfAborted(signal);

			if (!text.trim()) {
				lastPlan = buildPlan("<empty.wav>");
				return { audio: EMPTY_PCM };
			}

			const avail = await adapter.availability();
			if (avail.status === "unavailable") {
				throw new Error(`piper unavailable: ${avail.reason}`);
			}

			const sampleRateHz = await adapter.readVoiceSampleRate();

			if (dryRun) {
				lastPlan = buildPlan("<dry-run.wav>");
				throwIfAborted(signal);
				return {
					audio: {
						bytes: new Uint8Array(0),
						sampleRateHz,
						channels: 1,
						format: "wav",
					},
				};
			}

			await mkdir(tmpDir, { recursive: true });
			const wavPath = join(tmpDir, `tts-${randomUUID()}.wav`);
			const plan = buildPlan(wavPath);
			lastPlan = plan;

			const started = performance.now();
			try {
				const result = await runCaptured(plan.command, plan.args, {
					signal,
					stdin: `${text}\n`,
					timeoutMs: options.timeoutMs ?? 60_000,
				});
				throwIfAborted(signal);
				const elapsed = Math.round(performance.now() - started);
				if (result.code !== 0) {
					throw new Error(
						`piper exited ${result.code}: ${result.stderr.toString("utf8").slice(0, 400)}`,
					);
				}
				const bytes = new Uint8Array(await readFile(wavPath));
				if (!isWavBuffer(bytes) || bytes.byteLength < 44) {
					throw new Error("piper_invalid_wav_output");
				}
				const channels = 1 as const;
				const audio: AudioChunk = {
					bytes,
					sampleRateHz,
					channels,
					format: "wav",
				};
				lastMetrics = {
					synthesizeMs: elapsed,
					outputBytes: bytes.byteLength,
					sampleRateHz,
					channels,
					durationSec: wavDurationSec(bytes, sampleRateHz, channels),
					textChars: text.length,
				};
				return { audio };
			} finally {
				if (!keepTemp) {
					await unlink(wavPath).catch(() => {});
				}
			}
		},
	};

	return adapter;
}

/**
 * @deprecated Prefer resolveLabPiperPaths() from runtime/lab-paths.ts.
 * Kept as a name for tests that inject paths; empty until lab env is set.
 */
export { resolveLabPiperPaths as resolveLabPiperDefaults } from "../runtime/lab-paths.ts";

/** Fixed phrase for `/gentle-voice test-speak` (lab). */
export const LAB_TEST_SPEAK_PHRASE =
	"Hola, soy Gentle Voice. Esta es una prueba de respuesta hablada.";
