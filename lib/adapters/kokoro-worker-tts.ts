/**
 * Kokoro ONNX TTS through a keep-alive Python worker.
 * The worker starts on the first sentence and keeps the model loaded until
 * dispose(). Esc discards the pending sentence; the worker stays up.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AdapterAvailability, TtsAdapter, TtsResult } from "../contracts.ts";
import { KOKORO_ARTIFACTS, KOKORO_DEFAULT_VOICE, KOKORO_LANG } from "../kokoro/manifest.ts";
import { kokoroVenvPython, kokoroWorkerScript, probeKokoroReadiness, resolveKokoroHome } from "../kokoro/home.ts";
import { AbortError, onAbort, throwIfAborted } from "../process-cancel.ts";
import { isWavBuffer } from "./wav.ts";

export const KOKORO_TTS_ID = "kokoro" as const;
const SAMPLE_RATE_HZ = 24_000;

export interface KokoroWorkerTtsOptions {
	readonly home?: string;
	readonly python?: string;
	readonly script?: string;
	readonly voice?: string;
	readonly tmpDir?: string;
	readonly startupTimeoutMs?: number;
	readonly requestTimeoutMs?: number;
	/** Test seam. Production spawns the venv Python. */
	readonly spawnWorker?: (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;
}

export interface KokoroWorkerTtsAdapter extends TtsAdapter {
	prewarm(): Promise<void>;
	dispose(): Promise<void>;
}

interface Pending {
	readonly resolve: (reply: { sampleRate: number }) => void;
	readonly reject: (error: Error) => void;
	readonly out: string;
	discarded: boolean;
}

function emptyResult(): TtsResult {
	return { audio: { bytes: new Uint8Array(0), sampleRateHz: SAMPLE_RATE_HZ, channels: 1, format: "wav" } };
}

export function createKokoroWorkerTtsAdapter(options: KokoroWorkerTtsOptions = {}): KokoroWorkerTtsAdapter {
	const home = options.home ?? resolveKokoroHome();
	const python = options.python ?? kokoroVenvPython(home);
	const script = options.script ?? kokoroWorkerScript();
	const voice = options.voice ?? KOKORO_DEFAULT_VOICE;
	const tmpDir = options.tmpDir ?? join(tmpdir(), "gentle-voice");
	const startupTimeoutMs = options.startupTimeoutMs ?? 60_000;
	const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
	const spawnWorker = options.spawnWorker
		?? ((command: string, args: readonly string[]) =>
			spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams);

	let child: ChildProcessWithoutNullStreams | undefined;
	let starting: Promise<ChildProcessWithoutNullStreams> | undefined;
	let nextId = 1;
	let stderrTail = "";
	const pending = new Map<number, Pending>();

	const failAll = (error: Error): void => {
		for (const [id, item] of pending) {
			pending.delete(id);
			if (item.discarded) void unlink(item.out).catch(() => {});
			else item.reject(error);
		}
	};

	const start = (): Promise<ChildProcessWithoutNullStreams> => {
		if (child) return Promise.resolve(child);
		if (starting) return starting;
		const model = join(home, KOKORO_ARTIFACTS.find((a) => a.id === "model")!.relativePath);
		const voices = join(home, KOKORO_ARTIFACTS.find((a) => a.id === "voices")!.relativePath);
		starting = new Promise<ChildProcessWithoutNullStreams>((resolveStart, rejectStart) => {
			const proc = spawnWorker(python, [script, "--model", model, "--voices", voices, "--lang", KOKORO_LANG, "--voice", voice]);
			let ready = false;
			const timer = setTimeout(() => {
				if (ready) return;
				proc.kill("SIGKILL");
				rejectStart(new Error(`kokoro worker did not start within ${startupTimeoutMs} ms`));
			}, startupTimeoutMs);
			proc.stderr.on("data", (chunk: Buffer) => {
				stderrTail = (stderrTail + chunk.toString("utf8")).slice(-800);
			});
			createInterface({ input: proc.stdout }).on("line", (line) => {
				let msg: { op?: string; id?: number; error?: string; sampleRate?: number };
				try {
					msg = JSON.parse(line) as typeof msg;
				} catch {
					return;
				}
				if (!ready) {
					clearTimeout(timer);
					if (msg.op === "ready") {
						ready = true;
						child = proc;
						resolveStart(proc);
					} else {
						rejectStart(new Error(msg.error ?? "kokoro worker failed to start"));
					}
					return;
				}
				if (typeof msg.id !== "number") return;
				const item = pending.get(msg.id);
				if (!item) return;
				pending.delete(msg.id);
				if (item.discarded) {
					void unlink(item.out).catch(() => {});
					return;
				}
				if (msg.op === "done") item.resolve({ sampleRate: msg.sampleRate ?? SAMPLE_RATE_HZ });
				else item.reject(new Error(msg.error ?? "kokoro_worker_error"));
			});
			proc.once("error", (error) => {
				clearTimeout(timer);
				rejectStart(error);
			});
			proc.once("exit", (code, signal) => {
				clearTimeout(timer);
				const detail = stderrTail.trim() ? `: ${stderrTail.trim().slice(-400)}` : "";
				const error = new Error(`kokoro worker exited (code=${code}, signal=${signal ?? "none"})${detail}`);
				if (!ready) rejectStart(error);
				if (child === proc) child = undefined;
				starting = undefined;
				failAll(error);
			});
		});
		starting.catch(() => {
			starting = undefined;
		});
		return starting;
	};

	return {
		id: KOKORO_TTS_ID,
		async availability(): Promise<AdapterAvailability> {
			if (options.python || options.home) {
				if (!existsSync(python)) return { status: "unavailable", reason: "kokoro_python_missing", detail: python };
				if (!existsSync(script)) return { status: "unavailable", reason: "kokoro_script_missing", detail: script };
				return { status: "ready", detail: `kokoro ${voice} (${KOKORO_LANG})` };
			}
			const readiness = probeKokoroReadiness();
			return readiness.ready
				? { status: "ready", detail: `kokoro ${voice} (${KOKORO_LANG})` }
				: { status: "unavailable", reason: readiness.reason, detail: readiness.home };
		},
		async prewarm(): Promise<void> {
			await start();
		},
		async synthesize(text, { signal }): Promise<TtsResult> {
			throwIfAborted(signal);
			const trimmed = text.trim();
			if (!trimmed) return emptyResult();
			const proc = await start();
			throwIfAborted(signal);
			await mkdir(tmpDir, { recursive: true });
			const id = nextId++;
			const out = join(tmpDir, `kokoro-${randomUUID()}.wav`);
			const reply = await new Promise<{ sampleRate: number }>((resolveReply, rejectReply) => {
				let release = (): void => {};
				const finish = (): void => {
					clearTimeout(timer);
					release();
				};
				const item: Pending = {
					out,
					discarded: false,
					resolve: (value) => {
						finish();
						resolveReply(value);
					},
					reject: (error) => {
						finish();
						rejectReply(error);
					},
				};
				const timer = setTimeout(() => {
					item.discarded = true;
					finish();
					rejectReply(new Error(`kokoro synthesis timed out after ${requestTimeoutMs} ms`));
				}, requestTimeoutMs);
				pending.set(id, item);
				release = onAbort(signal, () => {
					item.discarded = true;
					finish();
					rejectReply(new AbortError());
				});
				proc.stdin.write(`${JSON.stringify({ id, text: trimmed, voice, out })}\n`);
			});
			try {
				const buf = await readFile(out);
				if (!isWavBuffer(buf)) throw new Error("kokoro worker did not produce a valid WAV");
				return {
					audio: {
						bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
						sampleRateHz: reply.sampleRate,
						channels: 1,
						format: "wav",
					},
				};
			} finally {
				await unlink(out).catch(() => {});
			}
		},
		async dispose(): Promise<void> {
			const proc = child;
			child = undefined;
			starting = undefined;
			failAll(new AbortError("kokoro worker disposed"));
			if (proc && proc.exitCode === null) proc.kill("SIGTERM");
		},
	};
}
