/**
 * Pure onboarding decisions. No downloads and no writes.
 * An explicit home is kept, but a tmpfs destination is not a permanent install.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { VIBEVOICE_MODEL_SAFETENSORS_BYTES } from "../adapters/vibevoice-tts.ts";
import { formatBytes } from "./artifacts.ts";
import {
	VIBEVOICE_MIN_FREE_DISK_MB,
	VIBEVOICE_MIN_VRAM_MB,
	type VibeVoiceHardwareReport,
} from "../vibevoice/install-plan.ts";
import type { TtsEnginePreference } from "../vibevoice/tts-preference.ts";

export const USE_PERSISTENT_LOCATION_PREFIX = "Use ";
export const KEEP_TEMPORARY_LOCATION = "Keep this temporary location";
export const ENGINE_VIBEVOICE = "VibeVoice";
export const ENGINE_PIPER = "Piper";
export const ENGINE_KOKORO = "Kokoro";
export const ENGINE_SKIP = "Skip";
export const SKIP_TTS = ENGINE_SKIP;
export const RECOMMENDED_FOR_SYSTEM = "(Recommended for your system)";
export const NOT_SUPPORTED_LABEL = "(Not supported)";
export const COMPATIBILITY_UNKNOWN_LABEL = "(Compatibility unknown)";
export const GPU_PREMIUM_LABEL = "(NVIDIA GPU, larger download)";

export type EngineChoice = "kokoro" | "vibevoice" | "piper" | "skip";

/** Kokoro needs Linux x64 or similar plus Python 3.11-3.14 for its private environment. */
export interface KokoroOption {
	readonly runnable: boolean;
	readonly installed: boolean;
}

export function envPreferringPersistentHome(
	env: NodeJS.ProcessEnv,
	clearXdg = false,
): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = { ...env };
	delete next.GENTLE_VOICE_HOME;
	delete next.GENTLE_VOICE_VIBEVOICE_HOME;
	delete next.GENTLE_VOICE_VIBEVOICE_ALLOW_TMPFS;
	if (clearXdg) {
		delete next.XDG_DATA_HOME;
		delete next.XDG_CACHE_HOME;
		delete next.XDG_CONFIG_HOME;
	}
	return next;
}

export function formatTemporaryLocationPrompt(current: string, persistent: string): string {
	return [
		"This location is on tmpfs. A permanent install does not belong here.",
		`Current: ${current}`,
		`Persistent: ${persistent}`,
		"Environment variables are left as you set them.",
	].join("\n");
}

export function weightsLookComplete(engineHome: string): boolean {
	try {
		return statSync(join(engineHome, "models", "VibeVoice-Realtime-0.5B", "model.safetensors")).size
			=== VIBEVOICE_MODEL_SAFETENSORS_BYTES;
	} catch {
		return false;
	}
}

export function explainTtsBlock(reasons: readonly string[]): string {
	if (reasons.includes("disk_below_12gb")) return "The destination has less than 12 GiB free.";
	if (reasons.includes("vram_below_4gb")) return "This NVIDIA GPU has less than 4 GB of VRAM.";
	if (reasons.includes("gpu_required")) return "VibeVoice requires a supported NVIDIA GPU.";
	if (reasons.includes("python3_required")) return "VibeVoice needs python3 to create its private environment.";
	if (reasons.includes("platform_unvalidated")) return "VibeVoice is checked on Linux x64 only.";
	if (reasons.includes("tmpfs_destination")) return "The destination is tmpfs. A permanent install needs a normal disk.";
	if (reasons.includes("gpu_probe_unavailable") || reasons.includes("disk_unknown") || reasons.length === 0) {
		return "VibeVoice compatibility could not be confirmed.";
	}
	return "VibeVoice is not available on this machine.";
}

export type VibeVoiceCompatibility = "supported" | "unsupported" | "unknown";
export type EngineInstallState = "installed" | "missing" | "incomplete" | "damaged";

/**
 * Hardware and platform only. Existing weights do not make a machine compatible.
 * A failed GPU probe is `unknown`, not `unsupported`.
 */
export function classifyVibeVoiceCompatibility(input: {
	readonly os: string;
	readonly arch: string;
	readonly hardware: VibeVoiceHardwareReport;
	readonly python3Available?: boolean;
}): { readonly compatibility: VibeVoiceCompatibility; readonly reasons: readonly string[] } {
	const reasons: string[] = [];
	const linux64 = input.os === "linux" && (input.arch === "x64" || input.arch === "x86_64");
	if (!linux64) reasons.push("platform_unvalidated");
	if (input.python3Available === false) reasons.push("python3_required");
	if (input.hardware.probe === "unavailable") reasons.push("gpu_probe_unavailable");
	else if (!input.hardware.nvidiaPresent) reasons.push("gpu_required");
	else if ((input.hardware.vramTotalMb ?? 0) < VIBEVOICE_MIN_VRAM_MB) reasons.push("vram_below_4gb");
	if (input.hardware.diskKnown === false) reasons.push("disk_unknown");
	else if (input.hardware.freeDiskMb < VIBEVOICE_MIN_FREE_DISK_MB) reasons.push("disk_below_12gb");
	const proven = reasons.some((reason) =>
		reason === "platform_unvalidated"
		|| reason === "python3_required"
		|| reason === "gpu_required"
		|| reason === "vram_below_4gb"
		|| reason === "disk_below_12gb",
	);
	if (proven) return { compatibility: "unsupported", reasons };
	if (reasons.some((reason) => reason === "gpu_probe_unavailable" || reason === "disk_unknown")) {
		return { compatibility: "unknown", reasons };
	}
	return { compatibility: "supported", reasons: [] };
}

export function vibevoiceInstallState(input: {
	readonly ready: boolean;
	readonly reason: string;
	readonly weightsPresent: boolean;
}): EngineInstallState {
	if (input.ready) return "installed";
	if (input.reason.startsWith("model_size_mismatch") || input.reason === "model_stat_failed") return "damaged";
	if (
		input.weightsPresent
		|| input.reason === "voice_missing"
		|| input.reason === "venv_missing"
		|| input.reason === "worker_script_missing"
	) return "incomplete";
	return "missing";
}

export function engineOptionLabel(name: string, tag?: string): string {
	return tag ? `${name}  ${tag}` : name;
}

/**
 * Pi highlights row 0 and has no initial index, so the recommended engine is first.
 * A runnable Kokoro is recommended; VibeVoice stays the opt-in GPU engine.
 */
export function voiceEngineOptions(
	compatibility: VibeVoiceCompatibility,
	piperRunnable: boolean,
	kokoro?: KokoroOption,
): { readonly recommended: EngineChoice; readonly options: readonly string[] } {
	if (kokoro?.runnable) {
		const premiumTag = compatibility === "supported"
			? GPU_PREMIUM_LABEL
			: compatibility === "unsupported"
				? NOT_SUPPORTED_LABEL
				: COMPATIBILITY_UNKNOWN_LABEL;
		return {
			recommended: "kokoro",
			options: [
				engineOptionLabel(ENGINE_KOKORO, RECOMMENDED_FOR_SYSTEM),
				engineOptionLabel(ENGINE_VIBEVOICE, premiumTag),
				ENGINE_PIPER,
				ENGINE_SKIP,
			],
		};
	}
	const vibeTag = compatibility === "supported"
		? RECOMMENDED_FOR_SYSTEM
		: compatibility === "unsupported"
			? NOT_SUPPORTED_LABEL
			: COMPATIBILITY_UNKNOWN_LABEL;
	const recommendPiper = compatibility !== "supported" && piperRunnable;
	const recommended = compatibility === "supported" ? "vibevoice" : recommendPiper ? "piper" : "skip";
	const labels = {
		vibevoice: engineOptionLabel(ENGINE_VIBEVOICE, vibeTag),
		piper: engineOptionLabel(ENGINE_PIPER, recommendPiper ? RECOMMENDED_FOR_SYSTEM : undefined),
		skip: ENGINE_SKIP,
	};
	const order = recommended === "vibevoice"
		? ["vibevoice", "piper", "skip"] as const
		: recommended === "piper"
			? ["piper", "vibevoice", "skip"] as const
			: ["skip", "vibevoice", "piper"] as const;
	return {
		recommended,
		options: order.map((id) => labels[id]),
	};
}

export function parseEngineChoice(value: string | undefined): EngineChoice | undefined {
	if (!value) return undefined;
	if (value.startsWith(ENGINE_KOKORO)) return "kokoro";
	if (value === ENGINE_SKIP || value.startsWith(`${ENGINE_SKIP} `)) return "skip";
	if (value.startsWith(ENGINE_VIBEVOICE)) return "vibevoice";
	if (value.startsWith(ENGINE_PIPER)) return "piper";
	return undefined;
}

export type EngineFollowUp =
	| { readonly kind: "skip" }
	| { readonly kind: "blocked"; readonly message: string }
	| { readonly kind: "activate"; readonly engine: Exclude<EngineChoice, "skip">; readonly notice: string }
	| { readonly kind: "confirm"; readonly engine: Exclude<EngineChoice, "skip">; readonly title: string; readonly message: string };

export function followEngineSelection(input: {
	readonly choice: EngineChoice | undefined;
	readonly compatibility: VibeVoiceCompatibility;
	readonly compatibilityReasons: readonly string[];
	readonly installBlocked: boolean;
	readonly blockReasons: readonly string[];
	readonly installState: EngineInstallState;
	readonly piperPresent: boolean;
	readonly location: string;
	readonly consentBody: string;
	readonly damageDetail?: string;
	readonly kokoroInstalled?: boolean;
}): EngineFollowUp {
	if (input.choice === undefined || input.choice === "skip") return { kind: "skip" };
	if (input.choice === "kokoro") {
		if (input.kokoroInstalled) return { kind: "activate", engine: "kokoro", notice: "Kokoro: Installed." };
		return { kind: "confirm", engine: "kokoro", title: "Install Kokoro?", message: input.consentBody };
	}
	if (input.choice === "piper") {
		if (input.piperPresent) return { kind: "activate", engine: "piper", notice: "Piper: Installed." };
		return {
			kind: "confirm",
			engine: "piper",
			title: "Install Piper?",
			message: `Not installed.\n${input.consentBody}`,
		};
	}
	if (input.compatibility === "unsupported" || input.installBlocked) {
		const reasons = input.installBlocked ? input.blockReasons : input.compatibilityReasons;
		return { kind: "blocked", message: `${explainTtsBlock(reasons)}\nVibeVoice was not installed.` };
	}
	if (input.installState === "installed") {
		return { kind: "activate", engine: "vibevoice", notice: "VibeVoice: Installed." };
	}
	const unknown = input.compatibility === "unknown"
		? "Compatibility could not be confirmed.\n\n"
		: "";
	if (input.installState === "incomplete") {
		return {
			kind: "confirm",
			engine: "vibevoice",
			title: "Finish VibeVoice installation?",
			message: `${unknown}The install did not finish. Missing files will be downloaded.\nLocation: ${input.location}`,
		};
	}
	if (input.installState === "damaged") {
		return {
			kind: "confirm",
			engine: "vibevoice",
			title: "Repair VibeVoice?",
			message: [
				unknown.trimEnd(),
				"Repair required.",
				input.damageDetail ? `Detail: ${input.damageDetail}` : "",
				"Valid files are kept.",
				`Location: ${input.location}`,
			].filter((line) => line !== "").join("\n"),
		};
	}
	return {
		kind: "confirm",
		engine: "vibevoice",
		title: "Install VibeVoice?",
		message: `${unknown}Not installed.\n${input.consentBody}`,
	};
}

export interface TtsRecommendation {
	readonly action: "ask" | "keep" | "ready" | "repair" | "inform";
	readonly recommended: EngineChoice;
	readonly title: string;
	readonly message: string;
	readonly options: readonly string[];
	readonly confirmTitle?: string;
	readonly confirmMessage?: string;
	readonly offerSwitch: boolean;
}

export function recommendTts(input: {
	readonly preference: TtsEnginePreference;
	readonly recommendationDeclined: boolean;
	readonly compatibility: VibeVoiceCompatibility;
	readonly compatibilityReasons: readonly string[];
	readonly piperRunnable: boolean;
	readonly installState: EngineInstallState;
	readonly installBlocked: boolean;
	readonly blockReasons: readonly string[];
	readonly location: string;
	readonly consentBody: string;
	readonly damageDetail?: string;
	readonly kokoro?: KokoroOption;
}): TtsRecommendation {
	const choice = voiceEngineOptions(input.compatibility, input.piperRunnable, input.kokoro);
	if (input.preference === "kokoro" && input.kokoro?.installed) {
		return {
			action: "keep",
			recommended: "kokoro",
			title: "Voice engine",
			message: "Kokoro stays your voice engine.",
			options: [],
			offerSwitch: false,
		};
	}
	if (input.preference === "piper") {
		return {
			action: "keep",
			recommended: "piper",
			title: "Voice engine",
			message: "Piper stays your voice engine.",
			options: [],
			offerSwitch: false,
		};
	}
	if (input.recommendationDeclined && input.preference !== "vibevoice") {
		return {
			action: "keep",
			recommended: choice.recommended,
			title: "Voice engine",
			message: "Voice-engine setup was skipped earlier.",
			options: [],
			offerSwitch: false,
		};
	}
	if (input.preference === "vibevoice") {
		if (input.compatibility === "unsupported") {
			return {
				action: "inform",
				recommended: "vibevoice",
				title: "Voice engine",
				message: `${explainTtsBlock(input.compatibilityReasons)}\nVibeVoice stays selected.`,
				options: [],
				offerSwitch: true,
			};
		}
		const follow = followEngineSelection({
			choice: "vibevoice",
			compatibility: input.compatibility,
			compatibilityReasons: input.compatibilityReasons,
			installBlocked: input.installBlocked,
			blockReasons: input.blockReasons,
			installState: input.installState,
			piperPresent: false,
			location: input.location,
			consentBody: input.consentBody,
			...(input.damageDetail ? { damageDetail: input.damageDetail } : {}),
		});
		if (follow.kind === "blocked") {
			return {
				action: "inform",
				recommended: "vibevoice",
				title: "Voice engine",
				message: `${follow.message}\nVibeVoice stays selected.`,
				options: [],
				offerSwitch: false,
			};
		}
		if (follow.kind === "activate") {
			return {
				action: "keep",
				recommended: "vibevoice",
				title: "Voice engine",
				message: follow.notice,
				options: [],
				offerSwitch: false,
			};
		}
		if (follow.kind === "confirm") {
			return {
				action: "repair",
				recommended: "vibevoice",
				title: "Voice engine",
				message: "VibeVoice stays selected.",
				options: [],
				confirmTitle: follow.title,
				confirmMessage: follow.message,
				offerSwitch: true,
			};
		}
	}
	if (input.installState === "installed" && input.compatibility === "supported" && !input.installBlocked) {
		return {
			action: "ready",
			recommended: "vibevoice",
			title: "Voice engine",
			message: "VibeVoice is already installed.",
			options: [],
			offerSwitch: false,
		};
	}
	return {
		action: "ask",
		recommended: choice.recommended,
		title: "Choose your voice engine",
		message: "Choosing an engine does not download it.",
		options: choice.options,
		offerSwitch: false,
	};
}

export function formatSpeechRecognitionPrompt(bytes: number, location: string): string {
	return [
		"Whisper.cpp turns speech into text. It is separate from the voice engine.",
		`Download: ~${formatBytes(bytes)}`,
		"Language: multilingual",
		`Location: ${location}`,
		"Nothing is installed until you accept.",
	].join("\n");
}

export function formatPiperPrompt(bytes: number, location: string): string {
	return [
		"Piper runs on CPU and does not need a GPU.",
		`Download: ~${formatBytes(bytes)}`,
		`Location: ${location}`,
		"Nothing is installed until you accept.",
	].join("\n");
}

export function explainVibeVoiceSetup(status: string, reason: string): string {
	if (reason.startsWith("archive_member_missing")) {
		return `The Spanish voice could not be installed. You can retry without downloading the model again.\nDetail: ${reason}`;
	}
	if (status === "partial") {
		return `Verified files were kept. Run /gentle-voice vibevoice-setup again to finish the missing pieces.\nDetail: ${reason}`;
	}
	if (status === "installed" || status === "reused") {
		return "VibeVoice files verified.";
	}
	if (status === "cancelled") return "Installation cancelled.";
	if (status === "declined") return "VibeVoice was not installed.";
	return `VibeVoice setup: ${status}\nDetail: ${reason}`;
}
