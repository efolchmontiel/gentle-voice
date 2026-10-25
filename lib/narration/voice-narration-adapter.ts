/**
 * VoiceNarrationAdapter — second LLM inference for speakable narration only.
 *
 * Never: tools, history mutation, orchestrator swap, profile edits.
 * Fallbacks: role_invalid / API error / timeout → deterministic (Speech Renderer input).
 * Cancel (Esc): path cancelled — caller must not play audio.
 */

import { checkNarrationFidelity } from "./fidelity-gate.ts";
import {
	buildNarrationUserMessage,
	NARRATION_SYSTEM_PROMPT,
	shouldPreferLiteralNarration,
} from "./narration-prompt.ts";
import { extractCompletionText } from "./model-registry-host.ts";
import {
	DEFAULT_VOICE_AI_ROLE,
	resolveNarratorFromProfiles,
} from "./profile-role-resolver.ts";
import type {
	NarrateInput,
	NarrateResult,
	NarrationDiagnostics,
	NarrationModelHost,
	NarratorResolution,
	VoiceNarrationAdapter,
} from "./types.ts";

export interface VoiceAiRuntimeConfig {
	readonly enabled: boolean;
	readonly role: string;
	readonly onError: "deterministic";
	readonly style: "natural";
	readonly timeoutMs: number;
	readonly maxInputChars: number;
	readonly preferredProfile?: string;
	readonly configHome?: string;
}

export const DEFAULT_VOICE_AI_RUNTIME: VoiceAiRuntimeConfig = Object.freeze({
	enabled: false,
	role: DEFAULT_VOICE_AI_ROLE,
	onError: "deterministic",
	style: "natural",
	timeoutMs: 25_000,
	maxInputChars: 8_000,
});

export interface CreateVoiceNarrationAdapterOptions {
	readonly config: VoiceAiRuntimeConfig;
	/** Live config reader (toggle enabled without recreating adapter). */
	readonly getConfig?: () => VoiceAiRuntimeConfig;
	readonly host?: NarrationModelHost;
	/** Lazy host (ExtensionContext.modelRegistry appears after session_start). */
	readonly getHost?: () => NarrationModelHost | undefined;
	readonly now?: () => number;
	readonly env?: NodeJS.ProcessEnv;
	/** Inject resolution for tests. */
	readonly resolveOverride?: (input: NarrateInput) => NarratorResolution;
	readonly hostKind?: string | (() => string | undefined);
	readonly onNotice?: (message: string) => void;
}

function raceTimeout<T>(
	promise: Promise<T>,
	ms: number,
	signal?: AbortSignal,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal?.aborted) {
			reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
			return;
		}
		const timer = setTimeout(() => {
			reject(Object.assign(new Error("narration timeout"), { name: "TimeoutError" }));
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(v) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

export function createVoiceNarrationAdapter(
	options: CreateVoiceNarrationAdapterOptions,
): VoiceNarrationAdapter {
	const readCfg = (): VoiceAiRuntimeConfig => options.getConfig?.() ?? options.config;
	const now = options.now ?? (() => Date.now());
	const env = options.env ?? process.env;
	let diag: NarrationDiagnostics = { enabled: readCfg().enabled };
	let announcedNoModel = false;

	const resolveProfiles = (
		input: Pick<NarrateInput, "sessionId" | "activeModel" | "activeThinking">,
	): NarratorResolution => {
		if (options.resolveOverride) {
			return options.resolveOverride(input as NarrateInput);
		}
		const cfg = readCfg();
		const hostKind = typeof options.hostKind === "function" ? options.hostKind() : options.hostKind;
		return resolveNarratorFromProfiles({
			roleName: cfg.role,
			sessionId: input.sessionId,
			activeModel: input.activeModel,
			activeThinking: input.activeThinking,
			...(cfg.configHome ? { configHome: cfg.configHome } : {}),
			...(cfg.preferredProfile ? { preferredProfile: cfg.preferredProfile } : {}),
			...(hostKind ? { hostKind } : {}),
			env,
		});
	};

	const resolveNarrator = (
		input: Pick<NarrateInput, "sessionId" | "activeModel" | "activeThinking">,
	): NarratorResolution => {
		const cfg = readCfg();
		if (!cfg.enabled) {
			return { status: "disabled", source: "disabled" };
		}
		return resolveProfiles(input);
	};

	const updateDiag = (partial: Partial<NarrationDiagnostics>): void => {
		diag = { ...diag, enabled: readCfg().enabled, ...partial };
	};

	const noticeFallback = (reason: string): void => {
		options.onNotice?.(`Voice AI fallback: ${reason}. Speaking the written reply.`);
	};

	return {
		resolveNarrator,
		/** Profile/role lookup even when narration is disabled (status must not show Profile none). */
		inspectNarrator: resolveProfiles,
		lastDiagnostics: () => ({ ...diag }),

		async narrate(input: NarrateInput): Promise<NarrateResult> {
			const cfg = readCfg();
			const started = now();
			const resolution = resolveNarrator(input);
			if (
				!announcedNoModel
				&& resolution.status === "ready"
				&& resolution.note === "voice-ai has no model configured"
			) {
				announcedNoModel = true;
				options.onNotice?.(
					resolution.source === "active_model_fallback"
						? `Voice AI: No dedicated model configured. Using the session model ${resolution.model.ref}.`
						: "Voice AI: No dedicated model configured. Using orchestrator.",
				);
			}
			updateDiag({
				narratorSource: resolution.source,
				profileName:
					"profileName" in resolution ? resolution.profileName : diag.profileName,
				...(resolution.status === "ready"
					? {
							narratorRef: resolution.model.ref,
							voiceAiRef:
								resolution.source === "role" ? resolution.model.ref : diag.voiceAiRef,
						}
					: {}),
			});

			if (resolution.status === "disabled") {
				const text = input.text;
				updateDiag({ lastPath: "deterministic", lastReason: "disabled", lastLatencyMs: now() - started });
				return {
					ok: true,
					path: "deterministic",
					text,
					reason: "voice_ai_disabled",
					resolution,
					latencyMs: now() - started,
				};
			}

			const raw = input.text?.trim() ?? "";
			if (!raw) {
				const emptyRes: NarratorResolution = {
					status: "no_eligible_text",
					source: "no_eligible_text",
				};
				updateDiag({ lastPath: "deterministic", lastReason: "no_eligible_text" });
				return {
					ok: true,
					path: "deterministic",
					text: "",
					reason: "no_eligible_text",
					resolution: emptyRes,
					latencyMs: now() - started,
				};
			}

			if (input.signal?.aborted) {
				updateDiag({ lastPath: "cancelled", lastReason: "aborted" });
				return {
					ok: false,
					path: "cancelled",
					reason: "aborted",
					resolution,
					latencyMs: now() - started,
				};
			}

			// Invalid narrator config → deterministic. Do not swap models quietly.
			if (resolution.status === "role_invalid") {
				updateDiag({
					lastPath: "deterministic",
					lastReason: resolution.reason,
					narratorRef: undefined,
				});
				noticeFallback(resolution.reason);
				return {
					ok: true,
					path: "deterministic",
					text: raw,
					reason: `role_invalid:${resolution.reason}`,
					resolution,
					latencyMs: now() - started,
				};
			}

			if (resolution.status !== "ready") {
				updateDiag({ lastPath: "deterministic", lastReason: resolution.status });
				noticeFallback(resolution.status);
				return {
					ok: true,
					path: "deterministic",
					text: raw,
					reason: `unexpected:${resolution.status}`,
					resolution,
					latencyMs: now() - started,
				};
			}

			const ready = resolution;

			if (shouldPreferLiteralNarration(raw)) {
				updateDiag({ lastPath: "deterministic", lastReason: "literal_content" });
				return {
					ok: true,
					path: "deterministic",
					text: raw,
					reason: "literal_content_gate",
					resolution: ready,
					latencyMs: now() - started,
				};
			}

			const host = options.getHost?.() ?? options.host;
			if (!host) {
				updateDiag({ lastPath: "deterministic", lastReason: "no_model_host" });
				noticeFallback("no_model_host");
				return {
					ok: true,
					path: "deterministic",
					text: raw,
					reason: "no_model_host",
					resolution: ready,
					latencyMs: now() - started,
				};
			}

			const maxChars = input.maxInputChars ?? cfg.maxInputChars;
			const clipped = raw.length > maxChars ? raw.slice(0, maxChars) : raw;

			const provider = ready.model.provider || "unknown";
			const model = host.find(provider, ready.model.id);
			if (!model) {
				// Treat unresolved catalogue as Case C / error → deterministic.
				updateDiag({
					lastPath: "deterministic",
					lastReason: `model_not_found:${ready.model.ref}`,
				});
				noticeFallback(`model_not_found:${ready.model.ref}`);
				return {
					ok: true,
					path: "deterministic",
					text: raw,
					reason: `model_not_found:${ready.model.ref}`,
					resolution: {
						status: "role_invalid",
						source: "role_invalid",
						...(ready.profileName ? { profileName: ready.profileName } : {}),
						role: ready.role ?? cfg.role,
						requestedRef: ready.model.ref,
						reason: `model not in registry: ${ready.model.ref}`,
					},
					latencyMs: now() - started,
				};
			}

			if (host.hasConfiguredAuth && !host.hasConfiguredAuth(model)) {
				updateDiag({
					lastPath: "deterministic",
					lastReason: `auth_missing:${ready.model.ref}`,
				});
				noticeFallback(`auth_missing:${ready.model.ref}`);
				return {
					ok: true,
					path: "deterministic",
					text: raw,
					reason: `auth_missing:${ready.model.ref}`,
					resolution: {
						status: "role_invalid",
						source: "role_invalid",
						...(ready.profileName ? { profileName: ready.profileName } : {}),
						role: ready.role ?? cfg.role,
						requestedRef: ready.model.ref,
						reason: `provider auth missing for ${ready.model.ref}`,
					},
					latencyMs: now() - started,
				};
			}

			const timeoutMs = input.timeoutMs ?? cfg.timeoutMs;
			try {
				const completion = await raceTimeout(
					host.complete(
						model,
						{
							systemPrompt: NARRATION_SYSTEM_PROMPT,
							messages: [
								{ role: "user", content: buildNarrationUserMessage(clipped, input.language) },
							],
						},
						{
							signal: input.signal,
							...(ready.model.thinking
								? { reasoning: ready.model.thinking }
								: {}),
						},
					),
					timeoutMs,
					input.signal,
				);

				if (input.signal?.aborted) {
					updateDiag({ lastPath: "cancelled", lastReason: "aborted" });
					return {
						ok: false,
						path: "cancelled",
						reason: "aborted",
						resolution: ready,
						latencyMs: now() - started,
					};
				}

				const providerError = completion.errorMessage?.trim()
					|| (completion.stopReason === "error" ? "provider returned an error" : "");
				if (providerError) {
					const brief = providerError.replace(/\s+/g, " ").slice(0, 160);
					updateDiag({ lastPath: "deterministic", lastReason: `provider_error:${ready.model.ref}` });
					noticeFallback(`${ready.model.ref} failed (${brief})`);
					return {
						ok: true,
						path: "deterministic",
						text: raw,
						reason: `provider_error:${ready.model.ref}`,
						resolution: ready,
						latencyMs: now() - started,
					};
				}

				const spoken = extractCompletionText(completion).trim();
				if (!spoken) {
					updateDiag({ lastPath: "deterministic", lastReason: "empty_llm" });
					noticeFallback("empty_llm_response");
					return {
						ok: true,
						path: "deterministic",
						text: raw,
						reason: "empty_llm_response",
						resolution: ready,
						latencyMs: now() - started,
					};
				}

				const fidelity = checkNarrationFidelity(clipped, spoken);
				if (!fidelity.ok) {
					updateDiag({
						lastPath: "deterministic",
						lastReason: "fidelity_fail",
						lastFidelityOk: false,
					});
					noticeFallback(`fidelity_fail:${fidelity.notes[0] ?? "check"}`);
					return {
						ok: true,
						path: "deterministic",
						text: raw,
						reason: `fidelity_fail:${fidelity.notes[0] ?? "check"}`,
						resolution: ready,
						latencyMs: now() - started,
					};
				}

				const usage = completion.usage
					? {
							inputTokens:
								completion.usage.inputTokens ?? completion.usage.input,
							outputTokens:
								completion.usage.outputTokens ?? completion.usage.output,
							totalTokens: completion.usage.totalTokens,
						}
					: undefined;

				updateDiag({
					lastPath: "llm",
					lastReason: undefined,
					lastLatencyMs: now() - started,
					lastFidelityOk: true,
					narratorRef: ready.model.ref,
					lastInvokedRef: ready.model.ref,
					...(usage ? { lastUsage: usage } : {}),
					...(ready.source === "role"
						? { voiceAiRef: ready.model.ref }
						: {}),
					...(ready.source === "orchestrator_fallback"
						? { orchestratorRef: ready.model.ref }
						: {}),
				});

				return {
					ok: true,
					path: "llm",
					text: spoken,
					resolution: ready,
					latencyMs: now() - started,
					...(usage ? { usage } : {}),
					fidelityOk: true,
					fidelityNotes: fidelity.notes,
				};
			} catch (err) {
				const name = err instanceof Error ? err.name : "";
				const msg = err instanceof Error ? err.message : String(err);
				if (name === "AbortError" || input.signal?.aborted) {
					updateDiag({ lastPath: "cancelled", lastReason: "aborted" });
					return {
						ok: false,
						path: "cancelled",
						reason: "aborted",
						resolution: ready,
						latencyMs: now() - started,
					};
				}
				if (name === "TimeoutError" || /timeout/i.test(msg)) {
					// Timeout → deterministic Speech Renderer (not Esc cancel).
					updateDiag({ lastPath: "deterministic", lastReason: "timeout" });
					noticeFallback("timeout");
					return {
						ok: true,
						path: "deterministic",
						text: raw,
						reason: "timeout",
						resolution: ready,
						latencyMs: now() - started,
					};
				}
				updateDiag({ lastPath: "deterministic", lastReason: `api_error:${msg.slice(0, 80)}` });
				noticeFallback(`api_error:${msg.slice(0, 120)}`);
				return {
					ok: true,
					path: "deterministic",
					text: raw,
					reason: `api_error:${msg.slice(0, 120)}`,
					resolution: ready,
					latencyMs: now() - started,
				};
			}
		},
	};
}
