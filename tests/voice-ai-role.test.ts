/**
 * Production voice-ai role: empty entry on every existing profile, host-local file.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseVoiceArgs, voiceHelpText } from "../lib/commands.ts";
import {
	ensureVoiceAiAgent,
	ensureVoiceAiRoles,
	resolveHostAgentDir,
	resolveHostProfilesFile,
	voiceAiAgentHasDiscoverableName,
	voiceAiAgentPath,
} from "../lib/profiles/voice-ai-role.ts";
import { resolveNarratorFromProfiles } from "../lib/narration/profile-role-resolver.ts";

function profiles(body: Record<string, unknown>): string {
	return `${JSON.stringify(
		{
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "OpenSource",
			profiles: body,
		},
		null,
		2,
	)}\n`;
}

test("add voice-ai is a public command", () => {
	const parsed = parseVoiceArgs("add voice-ai");
	assert.equal(parsed.command, "add");
	assert.equal(parsed.rest, "voice-ai");
	assert.equal(parsed.error, undefined);
	assert.match(voiceHelpText(), /\/gentle-voice add voice-ai/);
});

test("bundled Gentle Shell writes its own profiles file", () => {
	const root = mkdtempSync(join(tmpdir(), "gv-role-"));
	const prefix = join(root, "gentle-shell");
	const agent = join(prefix, "agent");
	const piDir = join(root, "pi", "gentle-ai");
	const gsFile = join(prefix, "config", "gentle-ai", "profiles.json");
	mkdirSync(join(prefix, "config", "gentle-ai"), { recursive: true });
	mkdirSync(piDir, { recursive: true });
	const before = profiles({
		OpenSource: { orchestrator: { model: "nan/glm", thinking: "high" }, "review-risk": { model: "nan/glm", thinking: "high" } },
		claude: { orchestrator: { model: "anthropic/claude", thinking: "medium" } },
	});
	writeFileSync(gsFile, before);
	writeFileSync(join(piDir, "profiles.json"), before);
	const env = {
		HOME: root,
		GENTLE_SHELL_PREFIX: prefix,
		GENTLE_PI_AGENT_HOME: agent,
		GENTLE_SHELL_CONFIG_HOME: join(prefix, "gentle-ai"),
	};
	assert.equal(resolveHostProfilesFile(env), gsFile);
	const result = ensureVoiceAiRoles(env);
	assert.equal(result.status, "updated");
	assert.deepEqual(result.added, ["OpenSource", "claude"]);
	const written = JSON.parse(readFileSync(gsFile, "utf8")) as {
		profiles: Record<string, Record<string, unknown>>;
	};
	assert.deepEqual(written.profiles.OpenSource["voice-ai"], {});
	assert.deepEqual(written.profiles.OpenSource.orchestrator, { model: "nan/glm", thinking: "high" });
	assert.deepEqual(written.profiles.claude["voice-ai"], {});
	const pi = JSON.parse(readFileSync(join(piDir, "profiles.json"), "utf8")) as {
		profiles: Record<string, Record<string, unknown>>;
	};
	assert.equal(pi.profiles.OpenSource["voice-ai"], undefined);
});

test("an existing voice-ai role is left alone", () => {
	const root = mkdtempSync(join(tmpdir(), "gv-role-"));
	const dir = join(root, ".pi", "gentle-ai");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "profiles.json");
	writeFileSync(
		file,
		profiles({
			OpenSource: {
				orchestrator: { model: "nan/glm", thinking: "high" },
				"voice-ai": { model: "nan/mimo-v2.6-flash", thinking: "low" },
			},
			other: { orchestrator: { model: "nan/glm", thinking: "high" } },
		}),
	);
	const env = { HOME: root };
	const result = ensureVoiceAiRoles(env);
	assert.equal(result.status, "updated");
	assert.deepEqual(result.added, ["other"]);
	const written = JSON.parse(readFileSync(file, "utf8")) as {
		profiles: Record<string, Record<string, { model?: string; thinking?: string }>>;
	};
	assert.equal(written.profiles.OpenSource["voice-ai"].model, "nan/mimo-v2.6-flash");
	assert.equal(written.profiles.OpenSource["voice-ai"].thinking, "low");
	assert.deepEqual(written.profiles.other["voice-ai"], {});
});

test("a missing profiles file is not created", () => {
	const root = mkdtempSync(join(tmpdir(), "gv-role-"));
	const marker = join(root, "shell", "gentle-ai");
	const piFile = join(root, ".pi", "gentle-ai", "profiles.json");
	mkdirSync(join(root, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(piFile, profiles({ OpenSource: { orchestrator: { model: "nan/glm" } } }));
	const env = {
		HOME: root,
		GENTLE_SHELL_CONFIG_HOME: marker,
		GENTLE_PI_AGENT_HOME: join(root, ".gentle-shell", "agent"),
	};
	const result = ensureVoiceAiRoles(env);
	assert.equal(result.status, "missing");
	assert.equal(existsSync(join(marker, "profiles.json")), false);
	const pi = JSON.parse(readFileSync(piFile, "utf8")) as { profiles: Record<string, Record<string, unknown>> };
	assert.equal(pi.profiles.OpenSource["voice-ai"], undefined);
});

test("Pi standalone uses ~/.pi/gentle-ai", () => {
	const root = mkdtempSync(join(tmpdir(), "gv-role-"));
	const file = join(root, ".pi", "gentle-ai", "profiles.json");
	mkdirSync(join(root, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(file, profiles({ OpenSource: { orchestrator: { model: "nan/glm", thinking: "high" } } }));
	const result = ensureVoiceAiRoles({ HOME: root });
	assert.equal(result.path, file);
	assert.equal(result.status, "updated");
	const written = JSON.parse(readFileSync(file, "utf8")) as {
		profiles: Record<string, Record<string, unknown>>;
	};
	assert.deepEqual(written.profiles.OpenSource["voice-ai"], {});
	assert.deepEqual(written.profiles.OpenSource.orchestrator, { model: "nan/glm", thinking: "high" });
});

test("voice-ai.md is created so Gentle Shell can discover the profile key", () => {
	const root = mkdtempSync(join(tmpdir(), "gv-role-"));
	const agent = join(root, "agent");
	const dir = join(root, ".pi", "gentle-ai");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "profiles.json"), profiles({ OpenSource: { orchestrator: { model: "nan/glm" } } }));
	const env = { HOME: root, GENTLE_PI_AGENT_HOME: agent, GENTLE_PI_CONFIG_HOME: dir };
	const result = ensureVoiceAiRoles(env);
	const file = voiceAiAgentPath(env);
	assert.equal(result.agentCreated, true);
	assert.equal(result.agentRepaired, false);
	assert.equal(result.agentPath, file);
	const text = readFileSync(file, "utf8");
	assert.equal(voiceAiAgentHasDiscoverableName(text), true);
	assert.doesNotMatch(text, /^model:/m);
	writeFileSync(file, text.replace("tools: []", "model: nan/kept\ntools: []"));
	const again = ensureVoiceAiRoles(env);
	assert.equal(again.agentCreated, false);
	assert.equal(again.agentRepaired, false);
	assert.match(readFileSync(file, "utf8"), /model: nan\/kept/);
});

test("standalone Gentle Shell agent home comes from GENTLE_SHELL_HOME", () => {
	const root = mkdtempSync(join(tmpdir(), "gv-role-"));
	const agent = join(root, ".gentle-shell", "agent");
	const env = { HOME: root, GENTLE_SHELL_HOME: agent };
	assert.equal(resolveHostAgentDir(env), agent);
	const created = ensureVoiceAiAgent(env);
	assert.equal(created.created, true);
	assert.equal(created.path, join(agent, "agents", "voice-ai.md"));
	assert.equal(existsSync(created.path), true);
});

test("a voice-ai.md without name: voice-ai is repaired without wiping model", () => {
	const root = mkdtempSync(join(tmpdir(), "gv-role-"));
	const agent = join(root, "agent");
	const file = join(agent, "agents", "voice-ai.md");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		["---", "name: narrator", "model: nan/kept", "thinking: low", "tools: []", "---", "", "keep body", ""].join("\n"),
	);
	const env = { HOME: root, GENTLE_PI_AGENT_HOME: agent };
	const result = ensureVoiceAiAgent(env);
	assert.equal(result.created, false);
	assert.equal(result.repaired, true);
	const text = readFileSync(file, "utf8");
	assert.equal(voiceAiAgentHasDiscoverableName(text), true);
	assert.match(text, /^model:\s*nan\/kept$/m);
	assert.match(text, /^thinking:\s*low$/m);
	assert.match(text, /keep body/);
});

test("agent file is created even when profiles.json is missing", () => {
	const root = mkdtempSync(join(tmpdir(), "gv-role-"));
	const agent = join(root, ".gentle-shell", "agent");
	const env = {
		HOME: root,
		GENTLE_PI_AGENT_HOME: agent,
		GENTLE_SHELL_CONFIG_HOME: join(root, ".gentle-shell", "gentle-ai"),
	};
	const result = ensureVoiceAiRoles(env);
	assert.equal(result.status, "missing");
	assert.equal(result.agentCreated, true);
	assert.equal(existsSync(result.agentPath), true);
	assert.equal(voiceAiAgentHasDiscoverableName(readFileSync(result.agentPath, "utf8")), true);
});

test("a model saved by /gentle:models is copied onto the empty role", () => {
	const root = mkdtempSync(join(tmpdir(), "gv-role-"));
	const dir = join(root, ".pi", "gentle-ai");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "profiles.json");
	writeFileSync(file, profiles({ OpenSource: { orchestrator: { model: "nan/glm", thinking: "high" }, "voice-ai": {} } }));
	writeFileSync(
		join(dir, "models.json"),
		`${JSON.stringify({ "voice-ai": { model: "nan/deepseek-v4-flash", thinking: "high" } }, null, 2)}\n`,
	);
	const env = { HOME: root, GENTLE_PI_CONFIG_HOME: dir, GENTLE_PI_AGENT_HOME: join(root, "agent") };
	const result = ensureVoiceAiRoles(env);
	assert.equal(result.status, "updated");
	const written = JSON.parse(readFileSync(file, "utf8")) as {
		profiles: Record<string, Record<string, { model?: string; thinking?: string }>>;
	};
	assert.equal(written.profiles.OpenSource["voice-ai"].model, "nan/deepseek-v4-flash");
	assert.equal(written.profiles.OpenSource["voice-ai"].thinking, "high");
	const resolved = resolveNarratorFromProfiles({
		env,
		configHome: dir,
		hostKind: "gs-isolated",
	});
	assert.equal(resolved.status, "ready");
	assert.equal(resolved.source, "role");
	if (resolved.status === "ready") assert.equal(resolved.model.ref, "nan/deepseek-v4-flash");
});
