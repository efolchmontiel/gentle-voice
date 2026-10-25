/**
 * /gentle-voice voice-ai status — real effective values, no sample models.
 */

import type { NarrationDiagnostics, NarratorResolution, NarratorSource } from "./types.ts";

export function hostStatusLabel(hostKind: string): string {
	if (hostKind === "pi-standalone") return "pi-standalone";
	if (hostKind.startsWith("gs-")) return "gentle-shell";
	return hostKind || "(unknown)";
}

export function narratorSourceLabel(
	source: NarratorSource | undefined,
	hostKind: string,
): string {
	if (source === "role") return "profile-role";
	if (source === "orchestrator_fallback") return "orchestrator-fallback";
	if (source === "active_model_fallback") {
		return hostKind === "pi-standalone" ? "active-pi-model" : "active-model";
	}
	if (source === "disabled") return "disabled";
	if (source === "role_invalid") return "invalid";
	if (source === "no_eligible_text") return "no-eligible-text";
	return source ?? "(none)";
}

export function narrationModeLabel(enabled: boolean): "llm-rewrite" | "deterministic" {
	return enabled ? "llm-rewrite" : "deterministic";
}

export interface VoiceAiStatusSnapshot {
	readonly hostKind: string;
	readonly enabled: boolean;
	readonly activationSource: string;
	readonly streaming: string;
	readonly resolution: NarratorResolution;
	/** Live orchestrator label from the host (provider/id), not a sample. */
	readonly orchestratorLabel: string;
	readonly diagnostics: NarrationDiagnostics;
	/** Measured on the last spoken turn. Omitted until those stages exist. */
	readonly narrationMs?: number;
	readonly synthToPlaybackMs?: number;
}

function modelLine(resolution: NarratorResolution): string {
	if (resolution.status === "ready") return resolution.model.ref;
	if (resolution.status === "role_invalid") return `(invalid ${resolution.requestedRef})`;
	return "(deterministic)";
}

function thinkingLine(resolution: NarratorResolution): string {
	if (resolution.status === "ready" && resolution.model.thinking) return resolution.model.thinking;
	if (resolution.status === "ready") return "(provider default)";
	return "(unset)";
}

function lastResult(path: NarrationDiagnostics["lastPath"]): string {
	if (path === "llm") return "llm";
	if (path === "deterministic") return "deterministic";
	if (path === "cancelled") return "cancelled";
	return "(none)";
}

export function formatVoiceAiStatus(snapshot: VoiceAiStatusSnapshot): string {
	const { resolution, diagnostics } = snapshot;
	const host = hostStatusLabel(snapshot.hostKind);
	const source = narratorSourceLabel(
		resolution.status === "disabled" ? "disabled" : resolution.source,
		snapshot.hostKind,
	);
	const profile =
		"profileName" in resolution && resolution.profileName
			? resolution.profileName
			: diagnostics.profileName;
	const tokens = diagnostics.lastUsage
		? [
			diagnostics.lastUsage.inputTokens != null ? `in=${diagnostics.lastUsage.inputTokens}` : "",
			diagnostics.lastUsage.outputTokens != null ? `out=${diagnostics.lastUsage.outputTokens}` : "",
			diagnostics.lastUsage.totalTokens != null ? `total=${diagnostics.lastUsage.totalTokens}` : "",
		].filter(Boolean).join(" ") || "(none)"
		: "(none)";
	const lines = [
		"Gentle Voice — Voice AI",
		`Host: ${host}`,
		`Voice AI: ${snapshot.enabled ? "enabled" : "disabled"}`,
		`Activation: ${snapshot.activationSource}`,
		...(profile ? [`Profile: ${profile}`] : []),
		`Narrator source: ${source}`,
		`Orchestrator: ${snapshot.orchestratorLabel}`,
		`Narrator: ${modelLine(resolution)}`,
		`Thinking: ${thinkingLine(resolution)}`,
		`Narration mode: ${narrationModeLabel(snapshot.enabled)}`,
		`Strategy: ${snapshot.streaming}`,
		`Last result: ${lastResult(diagnostics.lastPath)}`,
		`Last invoked: ${diagnostics.lastInvokedRef ?? "(none)"}`,
		`Latency: ${diagnostics.lastLatencyMs != null ? `${diagnostics.lastLatencyMs}ms` : "(none)"}`,
		`Tokens: ${tokens}`,
		`Fallback: ${diagnostics.lastReason ?? "(none)"}`,
		...(snapshot.narrationMs !== undefined ? [`Voice AI latency: ${snapshot.narrationMs}ms`] : []),
		...(snapshot.synthToPlaybackMs !== undefined
			? [`Synth to playback: ${snapshot.synthToPlaybackMs}ms`]
			: []),
		...("note" in resolution && resolution.note ? [`Note: ${resolution.note}`] : []),
		"Written reply stays the orchestrator text. TTS speaks the narration.",
	];
	return lines.join("\n");
}
