/**
 * Resolve narrator model from Gentle Shell profiles.json + optional session binding.
 *
 * Low coupling: reads the documented profiles schema; does NOT import gentle-shell.
 * Session binding is discovered via Symbol.for("gentle-pi:session-profile-bindings")
 * when GS is loaded in the same process (best-effort).
 *
 * Precedence for profile config:
 *   1. Session binding snapshot (Enter in /gentle:profiles)
 *   2. profiles.json active profile
 *   3. Named fallback profile (lab host, optional)
 *
 * Narrator selection:
 *   A — role has model and thinking → that role
 *   B — role has model, no thinking → that model, thinking left unset
 *   C — role exists with no model → profile orchestrator
 *   D — role absent → profile orchestrator, else active Pi model
 *   F — unsafe model id → role_invalid (caller shows the reason, deterministic TTS)
 *   `/gentle:models` writes `models.json`. That voice-ai entry wins over the profile
 *   role, including an empty entry (inherit).
 *   Pi standalone (no profile opt-in) → active Pi model only. No profiles file,
 *   session binding, or frozen Gentle Shell snapshot.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readVoiceAiModelsAssignment } from "../profiles/voice-ai-role.ts";
import type {
	NarrationThinkingLevel,
	NarratorModelRef,
	NarratorResolution,
} from "./types.ts";

export const PROFILES_KIND = "gentle-pi.agent_model_profiles";
export const PROFILES_VERSION = 1;
export const PROFILE_ORCHESTRATOR_KEY = "orchestrator";
export const DEFAULT_VOICE_AI_ROLE = "voice-ai";

const BINDINGS_SYMBOL = Symbol.for("gentle-pi:session-profile-bindings");
/** GS inherited-profile freeze (session keeps this until Enter). Orchestrator key is stripped there. */
const FREEZE_SYMBOL = Symbol.for("gentle-pi:session-profile-freeze");
const SAFE_MODEL_ID = /^[A-Za-z0-9._~:@/+%-]+$/;
const THINKING_LEVELS = new Set<string>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export interface RoutingEntry {
	readonly model?: string;
	readonly thinking?: NarrationThinkingLevel;
}

export type ProfileRouting = Record<string, RoutingEntry>;

export interface ProfilesFile {
	readonly kind: typeof PROFILES_KIND;
	readonly version: typeof PROFILES_VERSION;
	readonly active?: string;
	readonly profiles: Record<string, ProfileRouting>;
}

export interface ResolveNarratorOptions {
	readonly roleName?: string;
	readonly sessionId?: string;
	readonly configHome?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Prefer this profile name when active is unset (lab). */
	readonly preferredProfile?: string;
	readonly activeModel?: { provider?: string; id: string };
	readonly activeThinking?: NarrationThinkingLevel;
	/**
	 * `pi-standalone` does not treat a profiles file that merely exists on disk
	 * as the active profile. Explicit `GENTLE_PI_CONFIG_HOME` or
	 * `GENTLE_VOICE_USE_PROFILES=1` opts in. Gentle Shell host kinds still read it.
	 */
	readonly hostKind?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userPiGentleAi(env: NodeJS.ProcessEnv): string {
	return join(env.HOME ?? "/tmp", ".pi", "gentle-ai");
}

/**
 * Same store `/gentle:profiles` reads when the lab marker is a mirror without `active`.
 * Explicit `GENTLE_PI_CONFIG_HOME` always wins. A shell marker with no active profile
 * falls through to `~/.pi/gentle-ai` so a lab mirror cannot hide OpenSource.
 */
export function resolveGentleConfigHome(env: NodeJS.ProcessEnv = process.env): string {
	const piHome = env.GENTLE_PI_CONFIG_HOME?.trim();
	if (piHome) return piHome;
	const userHome = userPiGentleAi(env);
	const shellHome = env.GENTLE_SHELL_CONFIG_HOME?.trim();
	if (!shellHome || shellHome === userHome) return userHome;
	const shellFile = readProfilesFile(profilesJsonPath(shellHome));
	if (shellFile?.active && shellFile.profiles[shellFile.active]) return shellHome;
	const userFile = readProfilesFile(profilesJsonPath(userHome));
	if (userFile?.active && userFile.profiles[userFile.active]) return userHome;
	return shellFile ? shellHome : userHome;
}

export function profilesJsonPath(configHome: string): string {
	return join(configHome, "profiles.json");
}

export function parseModelRef(raw: string): NarratorModelRef | undefined {
	const trimmed = raw.trim();
	if (!trimmed || !SAFE_MODEL_ID.test(trimmed)) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0) {
		return { provider: "", id: trimmed, ref: trimmed };
	}
	const provider = trimmed.slice(0, slash);
	const id = trimmed.slice(slash + 1);
	if (!provider || !id) return undefined;
	return { provider, id, ref: trimmed };
}

function normalizeThinking(value: unknown): NarrationThinkingLevel | undefined {
	return typeof value === "string" && THINKING_LEVELS.has(value)
		? (value as NarrationThinkingLevel)
		: undefined;
}

function normalizeEntry(value: unknown): RoutingEntry | undefined {
	if (typeof value === "string") {
		const model = value.trim();
		return model && SAFE_MODEL_ID.test(model) ? { model } : undefined;
	}
	if (!isRecord(value)) return undefined;
	const modelRaw = typeof value.model === "string" ? value.model.trim() : "";
	const model = modelRaw && SAFE_MODEL_ID.test(modelRaw) ? modelRaw : undefined;
	const thinking =
		normalizeThinking(value.thinking) ?? normalizeThinking(value.effort);
	if (!model && !thinking) {
		return Object.keys(value).length === 0 ? {} : undefined;
	}
	return {
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
	};
}

export function readProfilesFile(path: string): ProfilesFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw)) return undefined;
		if (raw.kind !== PROFILES_KIND || raw.version !== PROFILES_VERSION) return undefined;
		const profiles: Record<string, ProfileRouting> = {};
		if (isRecord(raw.profiles)) {
			for (const [name, cfg] of Object.entries(raw.profiles)) {
				if (!isRecord(cfg)) continue;
				const routing: ProfileRouting = {};
				for (const [agent, entry] of Object.entries(cfg)) {
					const norm = normalizeEntry(entry);
					if (norm) routing[agent] = norm;
				}
				profiles[name] = routing;
			}
		}
		return {
			kind: PROFILES_KIND,
			version: PROFILES_VERSION,
			...(typeof raw.active === "string" ? { active: raw.active } : {}),
			profiles,
		};
	} catch {
		return undefined;
	}
}

interface SessionBindingLike {
	readonly name: string;
	readonly modelProfiles: ProfileRouting;
}

/**
 * Best-effort read of GS in-process session bindings (same Symbol.for key).
 * Returns undefined when GS is not loaded or session has no binding.
 */
export function readSessionBindingSnapshot(
	sessionId: string | undefined,
): SessionBindingLike | undefined {
	if (!sessionId) return undefined;
	try {
		const holder = globalThis as Record<symbol, unknown>;
		const map = holder[BINDINGS_SYMBOL];
		if (!(map instanceof Map)) return undefined;
		const binding = map.get(sessionId) as
			| { name?: string; modelProfiles?: Record<string, unknown> }
			| undefined;
		if (!binding || typeof binding.name !== "string" || !isRecord(binding.modelProfiles)) {
			return undefined;
		}
		const routing: ProfileRouting = {};
		for (const [agent, entry] of Object.entries(binding.modelProfiles)) {
			const norm = normalizeEntry(entry);
			if (norm) routing[agent] = norm;
		}
		return { name: binding.name, modelProfiles: routing };
	} catch {
		return undefined;
	}
}

function routingFromUnknown(raw: Record<string, unknown>): ProfileRouting {
	const routing: ProfileRouting = {};
	for (const [agent, entry] of Object.entries(raw)) {
		const norm = normalizeEntry(entry);
		if (norm) routing[agent] = norm;
	}
	return routing;
}

/**
 * Inherited snapshot GS froze at startup (`resolveSessionProfile` kind inherited).
 * Not the same map as an explicit Enter binding.
 */
export function readFrozenProfileSnapshot(
	sessionId: string | undefined,
): SessionBindingLike | undefined {
	if (!sessionId) return undefined;
	try {
		const holder = globalThis as Record<symbol, unknown>;
		const registry = holder[FREEZE_SYMBOL];
		if (!isRecord(registry)) return undefined;
		const frozenMap = registry.frozen;
		if (!(frozenMap instanceof Map)) return undefined;
		const slot = frozenMap.get(sessionId) as { profile?: unknown } | undefined;
		const profile = slot?.profile;
		if (!isRecord(profile) || typeof profile.name !== "string" || !profile.name) return undefined;
		if (!isRecord(profile.modelProfiles)) return undefined;
		return {
			name: profile.name,
			modelProfiles: routingFromUnknown(profile.modelProfiles),
		};
	} catch {
		return undefined;
	}
}

function entryToModel(
	entry: RoutingEntry | undefined,
	thinkingFallback?: NarrationThinkingLevel,
): NarratorModelRef | undefined {
	if (!entry?.model) return undefined;
	const parsed = parseModelRef(entry.model);
	if (!parsed) return undefined;
	const thinking = entry.thinking ?? thinkingFallback;
	return thinking ? { ...parsed, thinking } : parsed;
}

function activeModelRef(
	active: { provider?: string; id: string } | undefined,
	thinking?: NarrationThinkingLevel,
): NarratorModelRef | undefined {
	if (!active?.id) return undefined;
	const provider = active.provider?.trim() ?? "";
	const ref = provider ? `${provider}/${active.id}` : active.id;
	const parsed = parseModelRef(ref);
	if (!parsed) return undefined;
	return thinking ? { ...parsed, thinking } : parsed;
}

/**
 * Resolve narrator for Voice AI (cases A/B/C). Does not validate provider availability —
 * that is the adapter's job via ModelRegistry.find / hasConfiguredAuth.
 */
export function resolveNarratorFromProfiles(
	options: ResolveNarratorOptions = {},
): NarratorResolution {
	const roleName = options.roleName?.trim() || DEFAULT_VOICE_AI_ROLE;
	const env = options.env ?? process.env;
	const configHome = options.configHome ?? resolveGentleConfigHome(env);
	const profileOptIn = Boolean(env.GENTLE_PI_CONFIG_HOME?.trim())
		|| env.GENTLE_VOICE_USE_PROFILES === "1";

	// Pi --extension must not inherit a Gentle Shell profile that happens to
	// be on disk or frozen in-process. The narrator is the live Pi model.
	if (options.hostKind === "pi-standalone" && !profileOptIn) {
		const active = activeModelRef(options.activeModel, options.activeThinking);
		if (active) {
			return {
				status: "ready",
				source: "active_model_fallback",
				model: active,
				note: "pi-standalone uses the active Pi model",
			};
		}
		return {
			status: "role_invalid",
			source: "role_invalid",
			role: roleName,
			requestedRef: "(none)",
			reason: "pi-standalone has no active model",
		};
	}

	const allowProfileFile = options.hostKind !== "pi-standalone" || profileOptIn;

	const sessionBinding = readSessionBindingSnapshot(options.sessionId);
	const frozen = sessionBinding ? undefined : readFrozenProfileSnapshot(options.sessionId);
	let profileName: string | undefined;
	let routing: ProfileRouting | undefined;
	let profileOrigin: "session" | "frozen" | "file" | undefined;

	if (sessionBinding) {
		profileName = sessionBinding.name;
		routing = sessionBinding.modelProfiles;
		profileOrigin = "session";
	} else if (frozen) {
		profileName = frozen.name;
		routing = frozen.modelProfiles;
		profileOrigin = "frozen";
	} else if (allowProfileFile) {
		const file = readProfilesFile(profilesJsonPath(configHome));
		if (file) {
			const name =
				(file.active && file.profiles[file.active] ? file.active : undefined)
				?? (options.preferredProfile && file.profiles[options.preferredProfile]
					? options.preferredProfile
					: undefined);
			if (name) {
				profileName = name;
				routing = file.profiles[name];
				profileOrigin = "file";
			}
		}
	}

	// Freeze copies roles only (GS strips orchestrator). Case B still needs that profile's orchestrator.
	if (allowProfileFile && routing && profileName && !routing[PROFILE_ORCHESTRATOR_KEY]?.model) {
		const file = readProfilesFile(profilesJsonPath(configHome));
		const saved = file?.profiles[profileName]?.[PROFILE_ORCHESTRATOR_KEY];
		if (saved?.model) {
			routing = { ...routing, [PROFILE_ORCHESTRATOR_KEY]: saved };
		}
	}
	const orchestratorEntry = routing?.[PROFILE_ORCHESTRATOR_KEY];
	const orchestratorRef = orchestratorEntry?.model;
	const orchestratorThinking = orchestratorEntry?.thinking;

	if (routing) {
		const savedNarrator = readVoiceAiModelsAssignment(configHome);
		const profileRole = Object.prototype.hasOwnProperty.call(routing, roleName)
			? routing[roleName]
			: undefined;
		const savedEntry = savedNarrator.present
			? normalizeEntry({
				...(savedNarrator.model ? { model: savedNarrator.model } : {}),
				...(savedNarrator.thinking ? { thinking: savedNarrator.thinking } : {}),
			})
			: undefined;
		const roleEntry = savedNarrator.present ? (savedEntry ?? {}) : profileRole;
		const roleExists = savedNarrator.present || profileRole !== undefined;

		if (roleExists) {
			const rawModel = roleEntry?.model?.trim() ?? "";
			// Case B: a model without thinking stays that model. Do not copy the
			// orchestrator's thinking onto the narrator.
			const model = rawModel ? entryToModel(roleEntry) : undefined;
			if (!model && rawModel) {
				return {
					status: "role_invalid",
					source: "role_invalid",
					...(profileName ? { profileName } : {}),
					...(profileOrigin ? { profileOrigin } : {}),
					...(orchestratorRef ? { orchestratorRef } : {}),
					...(orchestratorThinking ? { orchestratorThinking } : {}),
					role: roleName,
					requestedRef: rawModel,
					reason: "voice-ai role has no valid model id",
				};
			}
			if (model) {
				return {
					status: "ready",
					source: "role",
					...(profileName ? { profileName } : {}),
					...(profileOrigin ? { profileOrigin } : {}),
					...(orchestratorRef ? { orchestratorRef } : {}),
					...(orchestratorThinking ? { orchestratorThinking } : {}),
					role: roleName,
					model,
				};
			}
		}

		// No narrator assigned: the session's own model speaks. GS strips the
		// orchestrator from the frozen profile because the session model is the
		// orchestrator; the saved profile orchestrator can differ from it.
		const emptyRole = roleExists && !(roleEntry?.model?.trim());
		const sessionModel = activeModelRef(options.activeModel, options.activeThinking);
		if (sessionModel) {
			return {
				status: "ready",
				source: "active_model_fallback",
				...(profileName ? { profileName } : {}),
				...(profileOrigin ? { profileOrigin } : {}),
				...(orchestratorRef ? { orchestratorRef } : {}),
				...(orchestratorThinking ? { orchestratorThinking } : {}),
				model: sessionModel,
				note: emptyRole
					? "voice-ai has no model configured"
					: `role ${roleName} absent; using the session model`,
			};
		}

		const orch = entryToModel(routing[PROFILE_ORCHESTRATOR_KEY], options.activeThinking);
		if (orch) {
			return {
				status: "ready",
				source: "orchestrator_fallback",
				...(profileName ? { profileName } : {}),
				...(profileOrigin ? { profileOrigin } : {}),
				orchestratorRef: orch.ref,
				...(orchestratorThinking ? { orchestratorThinking } : {}),
				model: orch,
				note: emptyRole
					? "voice-ai has no model configured"
					: `role ${roleName} absent; using profile orchestrator`,
			};
		}
	}

	const active = activeModelRef(options.activeModel, options.activeThinking);
	if (active) {
		return {
			status: "ready",
			source: "active_model_fallback",
			...(profileName ? { profileName } : {}),
			...(profileOrigin ? { profileOrigin } : {}),
			...(orchestratorRef ? { orchestratorRef } : {}),
			...(orchestratorThinking ? { orchestratorThinking } : {}),
			model: active,
			note: routing
				? `role ${roleName} and orchestrator unset; using active Pi model`
				: "no GS profiles; using active Pi model",
		};
	}

	return {
		status: "role_invalid",
		source: "role_invalid",
		...(profileName ? { profileName } : {}),
		...(profileOrigin ? { profileOrigin } : {}),
		...(orchestratorRef ? { orchestratorRef } : {}),
		...(orchestratorThinking ? { orchestratorThinking } : {}),
		role: roleName,
		requestedRef: "(none)",
		reason: "no voice-ai role, orchestrator, or active model available",
	};
}
