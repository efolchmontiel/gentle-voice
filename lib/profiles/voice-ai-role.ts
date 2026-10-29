/**
 * Production seed for the `voice-ai` role.
 *
 * The role is added empty. Model and thinking are chosen later in `/gentle:profiles`
 * (or `/gentle:models`). A missing profiles file is never created. An existing
 * `voice-ai` entry is never overwritten. The write stays on this host's Gentle AI
 * store and does not fall through to the other product.
 *
 * Gentle Shell discovers agents from markdown under the session agent home. A
 * profile key without a matching `agents/voice-ai.md` is reported as unmatched
 * and ignored at launch. This module always ensures that file exists in the
 * host agent home before touching profiles.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
	defaultGentleShellPrefixFromAgent,
	effectiveAgentHome,
	isDefaultGentleShellAgentDir,
	isPathInside,
	pathsEqual,
	resolveGentleVoiceStorage,
} from "../runtime/storage.ts";

export const VOICE_AI_ROLE_NAME = "voice-ai" as const;

const PROFILES_KIND = "gentle-pi.agent_model_profiles";
const PROFILES_VERSION = 1;

export type VoiceAiRoleStatus = "missing" | "invalid" | "unchanged" | "updated";

export interface EnsureVoiceAiRolesResult {
	readonly path: string;
	readonly status: VoiceAiRoleStatus;
	readonly added: readonly string[];
	readonly reason?: string;
	readonly agentPath: string;
	readonly agentCreated: boolean;
	readonly agentRepaired: boolean;
}

/** Discoverable by Gentle Shell. No model/thinking here — those are saved in the profiles panel. */
export const VOICE_AI_AGENT_MARKDOWN = `---
name: voice-ai
description: Gentle Voice narration role. Assign the model and effort in /gentle:profiles. This is not a task agent.
tools: []
---

This file exists so Gentle Shell can discover the voice-ai role and /gentle:profiles can assign its narrator. It does not run tasks.
`;

export interface VoiceAiModelsAssignment {
	readonly present: boolean;
	readonly model?: string;
	readonly thinking?: string;
}

export interface EnsureVoiceAiAgentResult {
	readonly path: string;
	readonly created: boolean;
	readonly repaired: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function homeDir(env: NodeJS.ProcessEnv): string {
	return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function piProfilesFile(env: NodeJS.ProcessEnv): string {
	const explicit = env.GENTLE_PI_CONFIG_HOME?.trim();
	const dir = explicit && isAbsolute(explicit) ? explicit : join(homeDir(env), ".pi", "gentle-ai");
	return join(dir, "profiles.json");
}

/**
 * Profiles file for the host that is actually running.
 *
 * Bundled Gentle Shell: `<prefix>/config/gentle-ai/profiles.json`.
 * Isolated Gentle Shell: `GENTLE_SHELL_CONFIG_HOME`, or `<prefix>/gentle-ai` beside the agent dir.
 * Pi, and Gentle Shell `--link`: `~/.pi/gentle-ai/profiles.json`.
 */
export function resolveHostProfilesFile(env: NodeJS.ProcessEnv = process.env): string {
	const prefix = env.GENTLE_SHELL_PREFIX?.trim();
	const agent = effectiveAgentHome(env);
	if (prefix && isAbsolute(prefix) && agent && isPathInside(prefix, agent)) {
		return join(prefix, "config", "gentle-ai", "profiles.json");
	}

	const userPi = env.GENTLE_SHELL_USER_PI_HOME?.trim();
	if (agent && userPi && pathsEqual(agent, userPi)) return piProfilesFile(env);

	const marker = env.GENTLE_SHELL_CONFIG_HOME?.trim();
	if (marker && isAbsolute(marker)) return join(marker, "profiles.json");

	if (agent && isDefaultGentleShellAgentDir(agent)) {
		const isolated = defaultGentleShellPrefixFromAgent(agent);
		if (isolated) return join(isolated, "gentle-ai", "profiles.json");
	}

	return piProfilesFile(env);
}

/**
 * Agent home Gentle Shell discovers (`agents/`, `subagents/`).
 * Prefer the same session signals storage uses; never invent a path by scanning disk.
 */
export function resolveHostAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const fromStorage = resolveGentleVoiceStorage({ env }).agentHome?.trim();
	if (fromStorage && isAbsolute(fromStorage)) return fromStorage;

	const explicit = effectiveAgentHome(env);
	if (explicit && isAbsolute(explicit)) return explicit;

	const gsHome = env.GENTLE_SHELL_HOME?.trim();
	if (gsHome && isAbsolute(gsHome)) return gsHome;

	return join(homeDir(env), ".pi", "agent");
}

export function voiceAiAgentPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveHostAgentDir(env), "agents", "voice-ai.md");
}

/** True when the file has a discoverable `name: voice-ai` frontmatter field. */
export function voiceAiAgentHasDiscoverableName(text: string): boolean {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	const frontmatter = match?.[1];
	if (!frontmatter) return false;
	return /^name:\s*voice-ai\s*$/m.test(frontmatter);
}

/**
 * Create or repair the agent file Gentle Shell must discover for the profile key.
 * Preserves an existing body and any model/thinking frontmatter already saved.
 */
export function ensureVoiceAiAgent(env: NodeJS.ProcessEnv = process.env): EnsureVoiceAiAgentResult {
	const path = voiceAiAgentPath(env);
	if (!existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, VOICE_AI_AGENT_MARKDOWN, { mode: 0o644 });
		return { path, created: true, repaired: false };
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		writeFileSync(path, VOICE_AI_AGENT_MARKDOWN, { mode: 0o644 });
		return { path, created: false, repaired: true };
	}
	if (voiceAiAgentHasDiscoverableName(text)) {
		return { path, created: false, repaired: false };
	}
	const bodyMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	const body = (bodyMatch?.[1] ?? text).trim()
		|| "This file exists so Gentle Shell can discover the voice-ai role. It does not run tasks.";
	const model = /^model:\s*(.+)$/m.exec(text)?.[1]?.trim();
	const thinking = /^(?:thinking|effort):\s*(.+)$/m.exec(text)?.[1]?.trim();
	const repaired = [
		"---",
		"name: voice-ai",
		"description: Gentle Voice narration role. Assign the model and effort in /gentle:profiles. This is not a task agent.",
		...(model ? [`model: ${model}`] : []),
		...(thinking ? [`thinking: ${thinking}`] : []),
		"tools: []",
		"---",
		"",
		body,
		"",
	].join("\n");
	writeFileSync(path, repaired, { mode: 0o644 });
	return { path, created: false, repaired: true };
}

/** Assignment `/gentle:models` / profiles panel writes beside `profiles.json`. */
export function readVoiceAiModelsAssignment(
	configHome: string,
): VoiceAiModelsAssignment {
	const path = join(configHome, "models.json");
	if (!existsSync(path)) return { present: false };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw) || !Object.prototype.hasOwnProperty.call(raw, VOICE_AI_ROLE_NAME)) {
			return { present: false };
		}
		const entry = raw[VOICE_AI_ROLE_NAME];
		if (!isRecord(entry)) return { present: true };
		const model = typeof entry.model === "string" ? entry.model.trim() : "";
		const thinking = typeof entry.thinking === "string" ? entry.thinking.trim() : "";
		return {
			present: true,
			...(model ? { model } : {}),
			...(thinking ? { thinking } : {}),
		};
	} catch {
		return { present: false };
	}
}

function assignmentBody(assignment: VoiceAiModelsAssignment): Record<string, string> {
	return {
		...(assignment.model ? { model: assignment.model } : {}),
		...(assignment.thinking ? { thinking: assignment.thinking } : {}),
	};
}

function detectIndent(text: string): string {
	const match = text.match(/\n([ \t]+)"/);
	return match?.[1] ?? "  ";
}

/**
 * Ensure the discoverable agent file exists, then add `"voice-ai": {}` to every
 * profile that does not already have the role. Does not create the profiles file
 * and does not invent a model. When the profiles panel has already saved a
 * voice-ai assignment in `models.json`, that assignment is copied onto the role.
 */
export function ensureVoiceAiRoles(env: NodeJS.ProcessEnv = process.env): EnsureVoiceAiRolesResult {
	const agent = ensureVoiceAiAgent(env);
	const path = resolveHostProfilesFile(env);
	const base = {
		path,
		agentPath: agent.path,
		agentCreated: agent.created,
		agentRepaired: agent.repaired,
	};
	if (!existsSync(path)) return { ...base, status: "missing", added: [] };

	let text: string;
	let raw: unknown;
	try {
		text = readFileSync(path, "utf8");
		raw = JSON.parse(text) as unknown;
	} catch {
		return { ...base, status: "invalid", added: [], reason: "unreadable" };
	}

	if (!isRecord(raw) || raw.kind !== PROFILES_KIND || raw.version !== PROFILES_VERSION || !isRecord(raw.profiles)) {
		return { ...base, status: "invalid", added: [], reason: "not a profiles file" };
	}

	const added: string[] = [];
	let synced = false;
	const assignment = readVoiceAiModelsAssignment(dirname(path));
	const saved = assignment.present ? assignmentBody(assignment) : undefined;
	for (const [name, profile] of Object.entries(raw.profiles)) {
		if (!isRecord(profile)) continue;
		if (!Object.prototype.hasOwnProperty.call(profile, VOICE_AI_ROLE_NAME)) {
			profile[VOICE_AI_ROLE_NAME] = saved ?? {};
			added.push(name);
			continue;
		}
		if (!saved) continue;
		if (JSON.stringify(profile[VOICE_AI_ROLE_NAME]) === JSON.stringify(saved)) continue;
		profile[VOICE_AI_ROLE_NAME] = saved;
		synced = true;
	}

	if (added.length === 0 && !synced) return { ...base, status: "unchanged", added };

	const mode = statSync(path).mode & 0o777;
	const next = `${JSON.stringify(raw, null, detectIndent(text))}\n`;
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, next, { mode });
	try {
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			/* the original profiles file is unchanged */
		}
		throw error;
	}
	return { ...base, status: "updated", added };
}
