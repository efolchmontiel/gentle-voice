/**
 * Consent plan for an optional VibeVoice engine directory.
 *
 * This module does not download, does not create a virtualenv, and does not
 * write the user's existing engine. The public command prints the plan.
 * `executeVibeVoiceInstall` runs only when a caller passes the consent token
 * and its own download function. This package does not pass one.
 */

import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import {
	VIBEVOICE_MODEL_SAFETENSORS_BYTES,
	VIBEVOICE_PREFERRED_VOICE,
} from "../adapters/vibevoice-tts.ts";

export const VIBEVOICE_MODEL_ID = "microsoft/VibeVoice-Realtime-0.5B";
export const VIBEVOICE_CODE_ORIGIN = "https://github.com/microsoft/VibeVoice";
export const VIBEVOICE_WEIGHTS_ORIGIN = "https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B";
export const VIBEVOICE_SPANISH_VOICE_ARCHIVE = "experimental_voices_sp.tar.gz";
/**
 * This upload does not contain `sp-Spk0_woman.pt`. Its members are
 * `sp/sp-Spk2_woman.pt`, `sp/sp-Spk3_man.pt`, `sp/sp-Spk4_woman.pt`, and
 * `sp/sp-Spk5_man.pt`. The validated voice ships inside the code archive.
 */
export const VIBEVOICE_EXPERIMENTAL_SP_ARCHIVE =
	"https://github.com/user-attachments/files/24035884/experimental_voices_sp.tar.gz";
export const VIBEVOICE_SPANISH_VOICE_MEMBER = "demo/voices/streaming_model/sp-Spk0_woman.pt";
export const VIBEVOICE_INSTALL_CONSENT_TOKEN = "INSTALL_VIBEVOICE";
/**
 * Total GPU memory below this blocks a new install.
 * The one measured load used about 2.6 GB on an 8 GB card. 4 GB is only a floor.
 */
export const VIBEVOICE_MIN_VRAM_MB = 4096;
/** The tested card. Crossing 4 GB does not mean that card was tested. */
export const VIBEVOICE_RECOMMENDED_VRAM_MB = 8192;
/**
 * The one measured engine tree was 8611023085 bytes, about 8.2 GiB,
 * before temporary download files. 8 GiB free cannot hold it.
 */
export const VIBEVOICE_MEASURED_TREE_BYTES = 8_611_023_085;
export const VIBEVOICE_MIN_FREE_DISK_MB = 12_288;
export const VIBEVOICE_RECOMMENDED_FREE_DISK_MB = 16_384;
export const VIBEVOICE_TESTED_HOST =
	"Linux x64, one NVIDIA RTX 2070 with 8 GB. Windows, macOS, CPU, and other GPUs have no supporting run.";

export interface VibeVoiceHardwareReport {
	readonly nvidiaPresent: boolean;
	/**
	 * `ok` — nvidia-smi reported a GPU.
	 * `no_gpu` — the command ran and no GPU memory was reported.
	 * `unavailable` — the command could not be run. That is not proof that a GPU is absent.
	 * Omitted by older fixtures; treated as a completed check.
	 */
	readonly probe?: "ok" | "no_gpu" | "unavailable";
	readonly vramTotalMb?: number;
	readonly freeDiskMb: number;
	/** False when free space could not be read. Omitted means the figure is known. */
	readonly diskKnown?: boolean;
	/** `findmnt` FSTYPE when known. `tmpfs` blocks a new install unless allowTmpfs is set. */
	readonly filesystem?: string;
}

export interface VibeVoiceDownloadStep {
	readonly id: "code" | "weights" | "spanish-voice";
	readonly origin: string;
	readonly bytes?: number;
}

export interface VibeVoiceInstallPlan {
	readonly status: "already_installed" | "needs_consent" | "blocked";
	readonly targetDir: string;
	readonly voice: typeof VIBEVOICE_PREFERRED_VOICE;
	readonly playback: "pcm";
	readonly reasons: readonly string[];
	readonly license: readonly string[];
	readonly downloads: readonly VibeVoiceDownloadStep[];
	readonly willNot: readonly string[];
}

const LICENSE_TERMS = [
	"Code license: MIT, Copyright (c) 2025 Microsoft.",
	"Weights are not in the gentle-voice package. The model card is research use.",
	"The published model is English-trained. Spanish is experimental and outside that training scope.",
	"Keep the audible disclaimer and the watermark. Do not strip them.",
	"Microsoft does not recommend commercial or real-world use without further testing.",
	"Out of scope includes impersonation, disinformation, live deepfake, and circumventing the watermark.",
] as const;

const WILL_NOT = [
	"change the system Python, CUDA toolkit, or NVIDIA drivers",
	"rewrite an engine directory that already passes the probe",
	"replace Piper or download Piper again",
	"put the weights inside the npm package",
] as const;

const DOWNLOADS: readonly VibeVoiceDownloadStep[] = [
	{ id: "code", origin: VIBEVOICE_CODE_ORIGIN },
	{
		id: "weights",
		origin: VIBEVOICE_WEIGHTS_ORIGIN,
		bytes: VIBEVOICE_MODEL_SAFETENSORS_BYTES,
	},
	{ id: "spanish-voice", origin: `${VIBEVOICE_CODE_ORIGIN} (${VIBEVOICE_SPANISH_VOICE_MEMBER})` },
];

function existingDirectory(path: string): string {
	let current = path;
	while (current && current !== dirname(current)) {
		try {
			statfsSync(current);
			return current;
		} catch {
			current = dirname(current);
		}
	}
	return "/";
}

export { python3CanCreateVenv } from "./python-runtime.ts";

/** Read-only. Does not install drivers, CUDA, or Python, and does not load a model. */
export function probeVibeVoiceHardware(targetDir: string): VibeVoiceHardwareReport {
	let nvidiaPresent = false;
	let probe: VibeVoiceHardwareReport["probe"] = "no_gpu";
	let vramTotalMb: number | undefined;
	try {
		const out = execFileSync(
			"nvidia-smi",
			["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
			{ encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
		);
		const first = Number(out.trim().split(/\r?\n/, 1)[0]?.trim());
		if (Number.isFinite(first) && first > 0) {
			nvidiaPresent = true;
			probe = "ok";
			vramTotalMb = first;
		}
	} catch {
		nvidiaPresent = false;
		probe = "unavailable";
	}
	let freeDiskMb = 0;
	let diskKnown = true;
	try {
		const stats = statfsSync(existingDirectory(targetDir));
		freeDiskMb = Math.floor((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
	} catch {
		freeDiskMb = 0;
		diskKnown = false;
	}
	let filesystem: string | undefined;
	try {
		filesystem = execFileSync("findmnt", ["-n", "-o", "FSTYPE", "-T", existingDirectory(targetDir)], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() || undefined;
	} catch {
		filesystem = undefined;
	}
	return {
		nvidiaPresent,
		probe,
		...(vramTotalMb !== undefined ? { vramTotalMb } : {}),
		freeDiskMb,
		diskKnown,
		...(filesystem ? { filesystem } : {}),
	};
}

export function planVibeVoiceInstall(input: {
	readonly targetDir: string;
	readonly hardware: VibeVoiceHardwareReport;
	readonly alreadyInstalled: boolean;
	readonly allowTmpfs?: boolean;
}): VibeVoiceInstallPlan {
	const base = {
		targetDir: input.targetDir,
		voice: VIBEVOICE_PREFERRED_VOICE,
		playback: "pcm" as const,
		license: LICENSE_TERMS,
		downloads: DOWNLOADS,
		willNot: WILL_NOT,
	};
	if (input.alreadyInstalled) {
		return {
			...base,
			status: "already_installed",
			reasons: ["engine directory already passes the probe; nothing will be downloaded or rewritten"],
		};
	}
	const reasons: string[] = [];
	if (input.hardware.probe !== "unavailable" && !input.hardware.nvidiaPresent) reasons.push("gpu_required");
	if (input.hardware.nvidiaPresent && (input.hardware.vramTotalMb ?? 0) < VIBEVOICE_MIN_VRAM_MB) {
		reasons.push("vram_below_4gb");
	} else if (
		input.hardware.nvidiaPresent
		&& (input.hardware.vramTotalMb ?? 0) < VIBEVOICE_RECOMMENDED_VRAM_MB
	) {
		reasons.push("vram_above_minimum_untested");
	}
	if (input.hardware.filesystem === "tmpfs" && !input.allowTmpfs) reasons.push("tmpfs_destination");
	if (input.hardware.diskKnown === false) {
		// Free space was not read. That is not proof the disk is too small.
	} else if (input.hardware.freeDiskMb < VIBEVOICE_MIN_FREE_DISK_MB) {
		reasons.push("disk_below_12gb");
	} else if (input.hardware.freeDiskMb < VIBEVOICE_RECOMMENDED_FREE_DISK_MB) {
		reasons.push("disk_below_recommended");
	}
	const blocking = reasons.filter((reason) =>
		reason === "gpu_required" || reason === "vram_below_4gb" || reason === "disk_below_12gb" || reason === "tmpfs_destination",
	);
	if (blocking.length > 0) return { ...base, status: "blocked", reasons };
	return {
		...base,
		status: "needs_consent",
		reasons: ["consent_required", ...reasons],
	};
}

export function formatVibeVoiceConsent(plan: VibeVoiceInstallPlan): string {
	return [
		"Recommended voice engine for Gentle Voice.",
		"",
		"Voice: Spanish, experimental (sp-Spk0_woman)",
		"GPU: NVIDIA, 4 GB VRAM minimum",
		"Storage: about 9 GiB on a persistent disk",
		`Location: ${plan.targetDir}`,
		"",
		"Research-oriented weights. Microsoft conditions apply.",
		"English-trained. Keep the audible disclaimer and the watermark.",
		"This is not a commercial authorization.",
		"",
		"Full terms, hashes, and file list:",
		"  /gentle-voice vibevoice-setup plan",
	].join("\n");
}

export function formatVibeVoiceInstallPlan(plan: VibeVoiceInstallPlan): string {
	const lines = [
		`vibevoice.setup=${plan.status}`,
		`target=${plan.targetDir}`,
		`voice=${plan.voice}`,
		`playback=${plan.playback}`,
		`reasons=${plan.reasons.join(",")}`,
		`vram.minimumMb=${VIBEVOICE_MIN_VRAM_MB}`,
		`vram.recommendedMb=${VIBEVOICE_RECOMMENDED_VRAM_MB}`,
		`disk.minimumMb=${VIBEVOICE_MIN_FREE_DISK_MB}`,
		`disk.recommendedMb=${VIBEVOICE_RECOMMENDED_FREE_DISK_MB}`,
		`disk.measuredTreeBytes=${VIBEVOICE_MEASURED_TREE_BYTES}`,
		`tested=${VIBEVOICE_TESTED_HOST}`,
		"downloads:",
		...plan.downloads.map((step) => `- ${step.id}: ${step.origin}${step.bytes ? ` (${step.bytes} bytes)` : ""}`),
		"license:",
		...plan.license.map((line) => `- ${line}`),
		"will not:",
		...plan.willNot.map((line) => `- ${line}`),
		"",
		"sp-Spk0_woman.pt is inside the VibeVoice code archive, under demo/voices/streaming_model.",
		"experimental_voices_sp.tar.gz does not contain that file. It is not downloaded.",
		"A new install downloads only after you accept the confirm dialog.",
		"The destination must be a persistent directory. tmpfs, including /tmp, is refused.",
		"That network step was not run in the simulated tests. Piper stays available.",
		"A local .venv belongs inside the target directory, not in the system Python.",
		"After a consented install, PCM is the playback default when pw-play supports float32.",
	];
	return lines.join("\n");
}

export interface VibeVoiceInstallExecution {
	readonly executed: boolean;
	readonly reason: string;
	readonly requested?: readonly string[];
}

/**
 * Runs only with the consent token and a caller-supplied download function.
 * The extension command does not call this.
 */
export async function executeVibeVoiceInstall(
	plan: VibeVoiceInstallPlan,
	deps: {
		readonly consentToken?: string;
		readonly download?: (step: VibeVoiceDownloadStep, targetDir: string) => Promise<void>;
	},
): Promise<VibeVoiceInstallExecution> {
	if (plan.status === "already_installed") return { executed: false, reason: "already_installed" };
	if (plan.status === "blocked") return { executed: false, reason: "blocked" };
	if (deps.consentToken !== VIBEVOICE_INSTALL_CONSENT_TOKEN) {
		return { executed: false, reason: "consent_required" };
	}
	if (!deps.download) return { executed: false, reason: "download_not_wired" };
	for (const step of plan.downloads) await deps.download(step, plan.targetDir);
	return {
		executed: true,
		reason: "downloaded",
		requested: plan.downloads.map((step) => step.origin),
	};
}
