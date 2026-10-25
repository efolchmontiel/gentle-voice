/**
 * TTS quality profiles — selection policy only.
 * Does not download models. Does not claim untested engines are operational.
 */

import type { TtsProviderInfo, TtsQualityProfile, TtsQualityProfileId } from "./providers.ts";

export type { TtsQualityProfileId };

export const TTS_QUALITY_PROFILES: readonly TtsQualityProfile[] = Object.freeze([
	Object.freeze({
		id: "light" as const,
		label: "Ligero",
		goal: "Mínima RAM/CPU; latencia corta; calidad aceptable para notificaciones.",
		preferredProviders: ["piper-es-medium", "espeak-ng-es", "piper-es-low"],
		maxModelBytesHint: 40 * 1024 * 1024,
		notes: "Prefer Piper medium/low when present; eSpeak-NG only as last resort (robotic).",
	}),
	Object.freeze({
		id: "balanced" as const,
		label: "Equilibrado",
		goal: "Buen tradeoff calidad/recursos para uso diario en lab.",
		preferredProviders: ["piper-es-AR-daniela-medium", "piper-es-AR-daniela-high", "piper-es-ES-sharvard-medium"],
		maxModelBytesHint: 120 * 1024 * 1024,
		notes: "Default inicial del lab hoy: daniela-high (única voz Piper local verificada).",
	}),
	Object.freeze({
		id: "natural" as const,
		label: "Natural",
		goal: "Máxima naturalidad local; mayor RAM/latencia aceptable.",
		preferredProviders: [
			"kokoro-ef-dora",
			"kokoro-em-alex",
			"sherpa-onnx-vits-es",
			"piper-es-AR-daniela-high",
		],
		notes:
			"Kokoro Spanish (ef_dora/em_alex) + Sherpa-ONNX are research candidates — NOT verified here. No auto-download. Human A/B required before claiming better naturalness than Piper.",
	}),
]);

/**
 * Research catalog (Phase 2B.1) — inventory of options WITHOUT claiming readiness.
 * verifiedLocally=true only when this machine has exercised the path.
 */
export const TTS_PROVIDER_RESEARCH_CATALOG: readonly TtsProviderInfo[] = Object.freeze([
	Object.freeze({
		id: "piper-es-AR-daniela-high",
		displayName: "Piper es_AR Daniela (high)",
		engine: "piper" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		verifiedLocally: true,
		licenseHint: "Voice models typically MIT (rhasspy/piper-voices); verify per voice README before redistribute",
		notes: "Lab-verified playback. User reports robotic prosody. ~114 MiB ONNX. Default until better voice authorized.",
	}),
	Object.freeze({
		id: "piper-es-AR-daniela-medium",
		displayName: "Piper es_AR Daniela (medium)",
		engine: "piper" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		verifiedLocally: false,
		licenseHint: "Same Piper voices repo — confirm before download",
		notes: "Smaller/faster sibling of daniela-high; not present locally. Candidate for profile light/balanced.",
	}),
	Object.freeze({
		id: "piper-es-ES-sharvard-medium",
		displayName: "Piper es_ES Sharvard (medium)",
		engine: "piper" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		verifiedLocally: false,
		licenseHint: "Piper voices catalog — check LICENSE",
		notes: "Castilian Spanish alternative; may sound less 'flat' to some listeners. Not downloaded.",
	}),
	Object.freeze({
		id: "piper-es-MX-claude-high",
		displayName: "Piper es_MX Claude (high)",
		engine: "piper" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		verifiedLocally: false,
		licenseHint: "Piper voices catalog — check LICENSE",
		notes: "Mexican Spanish high-quality Piper voice; research only.",
	}),
	Object.freeze({
		id: "espeak-ng-es",
		displayName: "eSpeak NG (Spanish)",
		engine: "espeak-ng" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		verifiedLocally: false,
		licenseHint: "GPL-3.0-or-later",
		notes: "Ubiquitous, tiny RAM, very robotic. Only for light/emergency fallback. Not wired.",
	}),
	Object.freeze({
		id: "sherpa-onnx-vits-es",
		displayName: "Sherpa-ONNX (engine) + Spanish VITS voice",
		engine: "sherpa-onnx" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		verifiedLocally: false,
		licenseHint: "Engine Apache-2.0; each voice checkpoint has its own license — verify before use",
		notes:
			"Sherpa-ONNX is an INFERENCE RUNTIME (C++/Python/JS bindings), not a voice. Pair with a Spanish VITS/Matcha checkpoint. Offline-capable. No install this phase. Do not conflate engine vs model.",
	}),
	Object.freeze({
		id: "kokoro-ef-dora",
		displayName: "Kokoro-82M ef_dora (ES female)",
		engine: "kokoro" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		verifiedLocally: true,
		licenseHint: "Apache-2.0 (hexgrad/Kokoro-82M + onnx-community ONNX)",
		notes:
			"Lab-only via GENTLE_VOICE_LAB + GENTLE_VOICE_LAB_ROOT / GENTLE_VOICE_KOKORO_*. Adapter kokoro-ef-dora. Human A/B vs Piper still required before changing default.",
	}),
	Object.freeze({
		id: "kokoro-em-alex",
		displayName: "Kokoro-82M em_alex (ES male)",
		engine: "kokoro" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		verifiedLocally: false,
		licenseHint: "Apache-2.0 (hexgrad/Kokoro-82M)",
		notes:
			"Official Spanish male voice. Same install surface as ef_dora. Candidate for A/B vs Piper daniela-high after authorized lab download.",
	}),
	Object.freeze({
		id: "kokoro-es",
		displayName: "Kokoro TTS (Spanish family)",
		engine: "kokoro" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		verifiedLocally: false,
		licenseHint: "Apache-2.0",
		notes: "Umbrella id for profiles; prefer kokoro-ef-dora / kokoro-em-alex for selection.",
	}),
	Object.freeze({
		id: "vibevoice-sp-Spk0_woman",
		displayName: "VibeVoice Realtime 0.5B sp-Spk0_woman (ES experimental)",
		engine: "vibevoice" as const,
		platforms: ["linux"] as const,
		verifiedLocally: true,
		licenseHint: "MIT (research weights; English-trained)",
		notes:
			"Optional keep-alive worker. PCM when the host can play float32; WAV via /gentle-voice stream wav. Audible disclaimer is kept. Not the Piper default.",
	}),
]);

export function getQualityProfile(id: TtsQualityProfileId | string): TtsQualityProfile | undefined {
	return TTS_QUALITY_PROFILES.find((p) => p.id === id);
}

/** Resolve preferred provider ids for a profile (policy only — no I/O). */
export function preferredProvidersForProfile(profileId: TtsQualityProfileId): readonly string[] {
	return getQualityProfile(profileId)?.preferredProviders ?? [];
}
