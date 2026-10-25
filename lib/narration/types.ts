/**
 * Voice AI narration types — second LLM turn for speakable text only.
 * Never mutates the orchestrator's written reply or session history.
 */

export type NarrationThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type NarratorSource =
	| "role"
	| "orchestrator_fallback"
	| "active_model_fallback"
	| "role_invalid"
	| "disabled"
	| "no_eligible_text";

export interface NarratorModelRef {
	readonly provider: string;
	readonly id: string;
	/** Display / config form: provider/id or bare id. */
	readonly ref: string;
	readonly thinking?: NarrationThinkingLevel;
}

/**
 * Resolution of who narrates. Distinct from "which model was invoked".
 * An invalid model id stays role_invalid. A role with no model uses the orchestrator
 * and sets note "voice-ai has no model configured" (one warning, not a silent swap).
 */
export type NarratorResolution =
	| {
			readonly status: "ready";
			readonly source: "role" | "orchestrator_fallback" | "active_model_fallback";
			readonly profileName?: string;
			readonly profileOrigin?: "session" | "frozen" | "file";
			readonly orchestratorRef?: string;
			readonly orchestratorThinking?: NarrationThinkingLevel;
			readonly role?: string;
			readonly model: NarratorModelRef;
			readonly note?: string;
	  }
	| {
			readonly status: "role_invalid";
			readonly source: "role_invalid";
			readonly profileName?: string;
			readonly profileOrigin?: "session" | "frozen" | "file";
			readonly orchestratorRef?: string;
			readonly orchestratorThinking?: NarrationThinkingLevel;
			readonly role: string;
			readonly requestedRef: string;
			readonly reason: string;
	  }
	| {
			readonly status: "disabled";
			readonly source: "disabled";
	  }
	| {
			readonly status: "no_eligible_text";
			readonly source: "no_eligible_text";
	  };

export type NarrationPath = "llm" | "deterministic" | "cancelled";

export interface NarrationUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
}

export interface NarrateInput {
	readonly text: string;
	readonly signal?: AbortSignal;
	/** Language the narration is spoken in ("es" or "en"); Spanish when absent. */
	readonly language?: string;
	/** Wall-clock timeout (ms). */
	readonly timeoutMs?: number;
	readonly maxInputChars?: number;
	readonly style?: "natural";
	/** Optional session id for GS session-bound profile lookup. */
	readonly sessionId?: string;
	/** Active orchestrator model from ExtensionContext (Pi / GS). */
	readonly activeModel?: { provider?: string; id: string };
	readonly activeThinking?: NarrationThinkingLevel;
}

export type NarrateResult =
	| {
			readonly ok: true;
			readonly path: "llm";
			readonly text: string;
			readonly resolution: NarratorResolution & { status: "ready" };
			readonly latencyMs: number;
			readonly usage?: NarrationUsage;
			readonly fidelityOk: boolean;
			readonly fidelityNotes?: readonly string[];
	  }
	| {
			readonly ok: true;
			readonly path: "deterministic";
			readonly text: string;
			readonly reason: string;
			readonly resolution: NarratorResolution;
			readonly latencyMs: number;
	  }
	| {
			readonly ok: false;
			readonly path: "cancelled";
			readonly reason: "aborted" | "timeout" | "user_cancel";
			readonly resolution: NarratorResolution;
			readonly latencyMs: number;
	  };

/** Minimal ModelRegistry surface used by narration (no GS imports). */
export interface NarrationModelHost {
	find(provider: string, modelId: string): unknown | undefined;
	hasConfiguredAuth?(model: unknown): boolean;
	complete(
		model: unknown,
		context: {
			systemPrompt?: string;
			messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
		},
		options?: {
			signal?: AbortSignal;
			reasoning?: string;
		},
	): Promise<{
		content?: unknown;
		usage?: {
			input?: number;
			output?: number;
			totalTokens?: number;
			inputTokens?: number;
			outputTokens?: number;
		};
		errorMessage?: string;
		stopReason?: string;
	}>;
}

export interface VoiceNarrationAdapter {
	resolveNarrator(input: Pick<NarrateInput, "sessionId" | "activeModel" | "activeThinking">): NarratorResolution;
	/** Always resolves profiles. Does not treat disabled narration as "no profile". */
	inspectNarrator(input: Pick<NarrateInput, "sessionId" | "activeModel" | "activeThinking">): NarratorResolution;
	narrate(input: NarrateInput): Promise<NarrateResult>;
	/** Last successful / attempted resolution for chrome / status. */
	lastDiagnostics(): NarrationDiagnostics;
}

export interface NarrationDiagnostics {
	readonly enabled: boolean;
	readonly profileName?: string;
	readonly orchestratorRef?: string;
	readonly voiceAiRef?: string;
	readonly narratorSource?: NarratorSource;
	readonly narratorRef?: string;
	readonly lastPath?: NarrationPath;
	readonly lastLatencyMs?: number;
	readonly lastReason?: string;
	readonly lastFidelityOk?: boolean;
	/** Model actually passed to ModelRegistry.complete (not merely configured). */
	readonly lastInvokedRef?: string;
	readonly lastUsage?: NarrationUsage;
}
