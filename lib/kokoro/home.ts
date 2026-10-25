/**
 * Where the product Kokoro engine lives and whether it is ready.
 * Reads the disk only. It never downloads or starts Python.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGentleVoiceStorage } from "../runtime/storage.ts";
import { KOKORO_ARTIFACTS, KOKORO_INTEGRITY_KIND } from "./manifest.ts";

export function resolveKokoroHome(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.GENTLE_VOICE_KOKORO_HOME?.trim();
	if (explicit) return explicit;
	const voiceHome = env.GENTLE_VOICE_HOME?.trim();
	if (voiceHome) return join(voiceHome, "kokoro");
	return join(resolveGentleVoiceStorage({ env }).dataDir, "kokoro");
}

export function kokoroVenvPython(home: string): string {
	return process.platform === "win32"
		? join(home, ".venv", "Scripts", "python.exe")
		: join(home, ".venv", "bin", "python");
}

export function kokoroWorkerScript(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "kokoro-worker.py");
}

export interface KokoroReadiness {
	readonly ready: boolean;
	readonly home: string;
	readonly reason: string;
}

/**
 * Ready means the install finished: the receipt exists, the venv Python is
 * there, and the pinned files have their pinned sizes. Hashes are checked at
 * install time, not on every launch.
 */
export function probeKokoroReadiness(env: NodeJS.ProcessEnv = process.env): KokoroReadiness {
	const home = resolveKokoroHome(env);
	if (!existsSync(home)) return { ready: false, home, reason: "home_missing" };
	try {
		const receipt = JSON.parse(readFileSync(join(home, "integrity.json"), "utf8")) as { kind?: string };
		if (receipt.kind !== KOKORO_INTEGRITY_KIND) return { ready: false, home, reason: "receipt_missing" };
	} catch {
		return { ready: false, home, reason: "receipt_missing" };
	}
	if (!existsSync(kokoroVenvPython(home))) return { ready: false, home, reason: "venv_missing" };
	for (const artifact of KOKORO_ARTIFACTS) {
		try {
			if (statSync(join(home, artifact.relativePath)).size !== artifact.bytes) {
				return { ready: false, home, reason: `size_mismatch:${artifact.id}` };
			}
		} catch {
			return { ready: false, home, reason: `missing:${artifact.id}` };
		}
	}
	if (!existsSync(kokoroWorkerScript())) return { ready: false, home, reason: "worker_script_missing" };
	return { ready: true, home, reason: "ready" };
}

export function isKokoroReady(env: NodeJS.ProcessEnv = process.env): boolean {
	return probeKokoroReadiness(env).ready;
}
