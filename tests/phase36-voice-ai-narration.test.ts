/**
 * Voice AI — narrator resolver + adapter fallbacks (no live provider calls).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	applyVoiceAiEnvOverrides,
	DEFAULT_VOICE_CONFIG,
	validateVoiceConfig,
} from "../lib/config.ts";
import {
	checkNarrationFidelity,
	createVoiceNarrationAdapter,
	formatVoiceAiStatus,
	NARRATION_SYSTEM_PROMPT,
	parseModelRef,
	readFrozenProfileSnapshot,
	resolveGentleConfigHome,
	resolveNarratorFromProfiles,
	resolveVoiceAiActivation,
	shouldPreferLiteralNarration,
	type NarrationModelHost,
} from "../lib/narration/index.ts";
import { resolveChromeActivity } from "../lib/widget-chrome.ts";
import { initialVoiceState } from "../lib/state-machine.ts";
import { classifyAssistantForSpeech } from "../lib/narration/final-speech-eligibility.ts";
import { parseVoiceArgs } from "../lib/commands.ts";

test("parseModelRef splits provider/id", () => {
	const m = parseModelRef("nan/mimo-v2.6-flash");
	assert.ok(m);
	assert.equal(m!.provider, "nan");
	assert.equal(m!.id, "mimo-v2.6-flash");
});

test("resolveNarrator: Case A role voice-ai", () => {
	const dir = mkdtempSync(join(tmpdir(), "gv-vai-"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "OpenSource",
			profiles: {
				OpenSource: {
					orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" },
					"voice-ai": { model: "nan/mimo-v2.6-flash", thinking: "low" },
					"review-risk": { model: "nan/other" },
				},
			},
		}),
	);
	const res = resolveNarratorFromProfiles({ configHome: dir });
	assert.equal(res.status, "ready");
	if (res.status === "ready") {
		assert.equal(res.source, "role");
		assert.equal(res.model.ref, "nan/mimo-v2.6-flash");
		assert.equal(res.model.thinking, "low");
		assert.equal(res.profileName, "OpenSource");
	}
});

test("resolveNarrator: Case B role absent → orchestrator", () => {
	const dir = mkdtempSync(join(tmpdir(), "gv-vai-b-"));
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "OpenSource",
			profiles: {
				OpenSource: {
					orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" },
				},
			},
		}),
	);
	const res = resolveNarratorFromProfiles({ configHome: dir });
	assert.equal(res.status, "ready");
	if (res.status === "ready") {
		assert.equal(res.source, "orchestrator_fallback");
		assert.equal(res.model.ref, "nan/deepseek-v4-flash");
	}
});

test("resolveNarrator: empty voice-ai model uses the orchestrator once", () => {
	const dir = mkdtempSync(join(tmpdir(), "gv-vai-c-"));
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "OpenSource",
			profiles: {
				OpenSource: {
					orchestrator: { model: "nan/deepseek-v4-flash" },
					"voice-ai": { thinking: "low" },
				},
			},
		}),
	);
	const res = resolveNarratorFromProfiles({ configHome: dir });
	assert.equal(res.status, "ready");
	if (res.status === "ready") {
		assert.equal(res.source, "orchestrator_fallback");
		assert.equal(res.model.ref, "nan/deepseek-v4-flash");
		assert.equal(res.note, "voice-ai has no model configured");
	}
});

test("resolveNarrator: pi-standalone ignores a profiles file on disk", () => {
	const dir = mkdtempSync(join(tmpdir(), "gv-vai-standalone-"));
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "OpenSource",
			profiles: {
				OpenSource: {
					orchestrator: { model: "nan/mimo-v2.6-flash" },
					"voice-ai": { model: "nan/mimo-v2.6-flash" },
				},
			},
		}),
	);
	const res = resolveNarratorFromProfiles({
		configHome: dir,
		hostKind: "pi-standalone",
		activeModel: { provider: "nan", id: "deepseek-v4-flash" },
	});
	assert.equal(res.status, "ready");
	if (res.status === "ready") {
		assert.equal(res.source, "active_model_fallback");
		assert.equal(res.model.ref, "nan/deepseek-v4-flash");
		assert.equal(res.profileOrigin, undefined);
	}
});

test("adapter: disabled → deterministic", async () => {
	const adapter = createVoiceNarrationAdapter({
		config: {
			enabled: false,
			role: "voice-ai",
			onError: "deterministic",
			style: "natural",
			timeoutMs: 5_000,
			maxInputChars: 1000,
		},
	});
	const r = await adapter.narrate({ text: "Hola mundo de prueba." });
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.path, "deterministic");
		assert.equal(r.text, "Hola mundo de prueba.");
	}
});

test("adapter: Case B orchestrator fallback calls host once without tools", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gv-vai-inf-"));
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "P",
			profiles: {
				P: { orchestrator: { model: "nan/deepseek-v4-flash" } },
			},
		}),
	);
	let calls = 0;
	const fakeModel = { id: "deepseek-v4-flash" };
	const host: NarrationModelHost = {
		find: (provider, id) => {
			assert.equal(provider, "nan");
			assert.equal(id, "deepseek-v4-flash");
			return fakeModel;
		},
		hasConfiguredAuth: () => true,
		complete: async (_model, context) => {
			calls += 1;
			assert.ok(context.systemPrompt?.includes("narración"));
			assert.equal(context.messages.length, 1);
			assert.equal(context.messages[0]?.role, "user");
			return {
				content: [{ type: "text", text: "Mirá, esto es una narración natural." }],
				usage: { inputTokens: 10, outputTokens: 8 },
			};
		},
	};
	const adapter = createVoiceNarrationAdapter({
		config: {
			enabled: true,
			role: "voice-ai",
			onError: "deterministic",
			style: "natural",
			timeoutMs: 5_000,
			maxInputChars: 2000,
			configHome: dir,
		},
		host,
	});
	const r = await adapter.narrate({
		text: "PostgreSQL es un sistema de gestión de bases de datos relacional.",
	});
	assert.equal(calls, 1);
	assert.equal(r.ok, true);
	if (r.ok && r.path === "llm") {
		assert.match(r.text, /narración natural/);
		assert.equal(r.resolution.source, "orchestrator_fallback");
		assert.equal(r.fidelityOk, true);
	} else {
		assert.fail(`expected llm path, got ${JSON.stringify(r)}`);
	}
});

test("adapter: Case C invalid model → deterministic, no second invent", async () => {
	let calls = 0;
	const host: NarrationModelHost = {
		find: () => undefined,
		complete: async () => {
			calls += 1;
			return { content: [] };
		},
	};
	const adapter = createVoiceNarrationAdapter({
		config: {
			enabled: true,
			role: "voice-ai",
			onError: "deterministic",
			style: "natural",
			timeoutMs: 5_000,
			maxInputChars: 2000,
		},
		host,
		resolveOverride: () => ({
			status: "ready",
			source: "role",
			role: "voice-ai",
			model: { provider: "nan", id: "missing-model", ref: "nan/missing-model" },
		}),
	});
	const src = "El resultado es 42 unidades.";
	const r = await adapter.narrate({ text: src });
	assert.equal(calls, 0);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.path, "deterministic");
		assert.equal(r.text, src);
		assert.match(r.reason, /model_not_found/);
	}
});

test("adapter: Esc abort → cancelled, no deterministic speak text path for caller", async () => {
	const ac = new AbortController();
	const host: NarrationModelHost = {
		find: () => ({}),
		hasConfiguredAuth: () => true,
		complete: async (_m, _c, opts) => {
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(resolve, 5_000);
				opts?.signal?.addEventListener("abort", () => {
					clearTimeout(t);
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				});
			});
			return { content: [{ type: "text", text: "nope" }] };
		},
	};
	const adapter = createVoiceNarrationAdapter({
		config: {
			enabled: true,
			role: "voice-ai",
			onError: "deterministic",
			style: "natural",
			timeoutMs: 10_000,
			maxInputChars: 2000,
		},
		host,
		resolveOverride: () => ({
			status: "ready",
			source: "role",
			role: "voice-ai",
			model: { provider: "nan", id: "mimo", ref: "nan/mimo" },
		}),
	});
	const p = adapter.narrate({
		text: "Texto largo suficiente para pasar el gate literal de narración conversacional.",
		signal: ac.signal,
	});
	ac.abort();
	const r = await p;
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.path, "cancelled");
});

test("fidelity gate catches missing numbers", () => {
	const bad = checkNarrationFidelity(
		"Se perdieron 1234 archivos en /home/svc/proyecto/data y 5678 en /opt/backup/nightly.",
		"Se perdieron algunos archivos en el sistema.",
	);
	assert.equal(bad.ok, false);
});

test("config voiceAi schema + env override", () => {
	const base = validateVoiceConfig(DEFAULT_VOICE_CONFIG);
	assert.equal(base.ok, true);
	if (base.ok) assert.equal(base.config.voiceAi.enabled, false);

	const on = applyVoiceAiEnvOverrides(DEFAULT_VOICE_CONFIG, { GENTLE_VOICE_AI: "1" });
	assert.equal(on.voiceAi.enabled, true);
	const off = applyVoiceAiEnvOverrides(on, { GENTLE_VOICE_AI: "0" });
	assert.equal(off.voiceAi.enabled, false);
});

test("inspectNarrator resolves profile even when narration is disabled", () => {
	const dir = mkdtempSync(join(tmpdir(), "gv-vai-inspect-"));
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "OpenSource",
			profiles: {
				OpenSource: {
					orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" },
					"voice-ai": { model: "nan/mimo-v2.6-flash", thinking: "low" },
				},
			},
		}),
	);
	const adapter = createVoiceNarrationAdapter({
		config: {
			enabled: false,
			role: "voice-ai",
			onError: "deterministic",
			style: "natural",
			timeoutMs: 1000,
			maxInputChars: 500,
			configHome: dir,
		},
	});
	const gated = adapter.resolveNarrator({});
	assert.equal(gated.status, "disabled");
	const inspected = adapter.inspectNarrator({});
	assert.equal(inspected.status, "ready");
	if (inspected.status === "ready") {
		assert.equal(inspected.profileName, "OpenSource");
		assert.equal(inspected.model.ref, "nan/mimo-v2.6-flash");
		assert.equal(inspected.orchestratorRef, "nan/deepseek-v4-flash");
	}
});

test("frozen session profile wins over a different file active", () => {
	const dir = mkdtempSync(join(tmpdir(), "gv-vai-freeze-"));
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "Other",
			profiles: {
				Other: { orchestrator: { model: "nan/other-model" } },
				OpenSource: {
					orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" },
					"voice-ai": { model: "nan/mimo-v2.6-flash", thinking: "low" },
				},
			},
		}),
	);
	const key = Symbol.for("gentle-pi:session-profile-freeze");
	const holder = globalThis as Record<symbol, { frozen: Map<string, unknown> } | undefined>;
	const previous = holder[key];
	holder[key] = {
		frozen: new Map([
			[
				"sess-1",
				{
					profile: {
						name: "OpenSource",
						origin: "global",
						modelProfiles: {
							"voice-ai": { model: "nan/mimo-v2.6-flash", thinking: "low" },
						},
					},
				},
			],
		]),
	};
	try {
		const snap = readFrozenProfileSnapshot("sess-1");
		assert.equal(snap?.name, "OpenSource");
		const res = resolveNarratorFromProfiles({ configHome: dir, sessionId: "sess-1" });
		assert.equal(res.status, "ready");
		if (res.status === "ready") {
			assert.equal(res.profileName, "OpenSource");
			assert.equal(res.profileOrigin, "frozen");
			assert.equal(res.source, "role");
			assert.equal(res.model.ref, "nan/mimo-v2.6-flash");
			assert.equal(res.orchestratorRef, "nan/deepseek-v4-flash");
		}
	} finally {
		if (previous === undefined) delete holder[key];
		else holder[key] = previous;
	}
});

test("shell marker without active falls through to ~/.pi/gentle-ai", () => {
	const root = mkdtempSync(join(tmpdir(), "gv-vai-home-"));
	const user = join(root, ".pi", "gentle-ai");
	const mirror = join(root, "lab-mirror");
	mkdirSync(user, { recursive: true });
	mkdirSync(mirror, { recursive: true });
	writeFileSync(
		join(user, "profiles.json"),
		JSON.stringify({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "OpenSource",
			profiles: { OpenSource: { orchestrator: { model: "nan/deepseek-v4-flash" } } },
		}),
	);
	writeFileSync(
		join(mirror, "profiles.json"),
		JSON.stringify({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			profiles: { "voice-ai": { orchestrator: { model: "nan/should-not-win" } } },
		}),
	);
	const home = resolveGentleConfigHome({
		HOME: root,
		GENTLE_SHELL_CONFIG_HOME: mirror,
	});
	assert.equal(home, user);
});

test("voice-ai preference: explicit off survives converse; unset follows converse", () => {
	const off = resolveVoiceAiActivation({ preference: "off", fluentConversation: true, env: {} });
	assert.equal(off.enabled, false);
	assert.equal(off.source, "explicit-off");
	const autoOn = resolveVoiceAiActivation({ preference: "unset", fluentConversation: true, env: {} });
	assert.equal(autoOn.enabled, true);
	assert.equal(autoOn.source, "automatic");
	const autoOff = resolveVoiceAiActivation({ preference: "unset", fluentConversation: false, env: {} });
	assert.equal(autoOff.enabled, false);
	const explicit = resolveVoiceAiActivation({ preference: "on", fluentConversation: false, env: {} });
	assert.equal(explicit.enabled, true);
	assert.equal(explicit.source, "explicit-on");
	const envLock = resolveVoiceAiActivation({
		preference: "unset",
		fluentConversation: true,
		env: { GENTLE_VOICE_AI: "0" },
	});
	assert.equal(envLock.enabled, false);
	assert.equal(envLock.source, "env-off");
});

test("voice-ai, barge-in and tts parse without lab mode", () => {
	const prev = process.env.GENTLE_VOICE_LAB;
	try {
		delete process.env.GENTLE_VOICE_LAB;
		const voice = parseVoiceArgs("voice-ai status");
		assert.equal(voice.command, "voice-ai");
		assert.equal(voice.rest, "status");
		assert.equal(voice.error, undefined);
		const barge = parseVoiceArgs("barge-in off");
		assert.equal(barge.command, "barge-in");
		assert.equal(barge.rest, "off");
		const tts = parseVoiceArgs("tts piper");
		assert.equal(tts.command, "tts");
		assert.equal(tts.rest, "piper");
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prev;
	}
});

test("pi-standalone ignores a frozen Gentle Shell voice-ai role", () => {
	const key = Symbol.for("gentle-pi:session-profile-freeze");
	const holder = globalThis as Record<symbol, { frozen: Map<string, unknown> } | undefined>;
	const previous = holder[key];
	holder[key] = {
		frozen: new Map([
			[
				"sess-pi",
				{
					profile: {
						name: "OpenSource",
						modelProfiles: {
							"voice-ai": { model: "nan/mimo-v2.6-flash", thinking: "low" },
							orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" },
						},
					},
				},
			],
		]),
	};
	try {
		const res = resolveNarratorFromProfiles({
			hostKind: "pi-standalone",
			sessionId: "sess-pi",
			env: {},
			activeModel: { provider: "openai", id: "gpt" },
			activeThinking: "high",
		});
		assert.equal(res.status, "ready");
		if (res.status === "ready") {
			assert.equal(res.source, "active_model_fallback");
			assert.equal(res.model.ref, "openai/gpt");
			assert.equal(res.profileName, undefined);
		}
	} finally {
		if (previous === undefined) delete holder[key];
		else holder[key] = previous;
	}
});

test("changing the active Pi model changes the narrator", () => {
	const first = resolveNarratorFromProfiles({
		hostKind: "pi-standalone",
		env: {},
		activeModel: { provider: "openai", id: "gpt" },
	});
	const second = resolveNarratorFromProfiles({
		hostKind: "pi-standalone",
		env: {},
		activeModel: { provider: "nan", id: "deepseek-v4-flash" },
	});
	assert.equal(first.status, "ready");
	assert.equal(second.status, "ready");
	if (first.status === "ready" && second.status === "ready") {
		assert.equal(first.model.ref, "openai/gpt");
		assert.equal(second.model.ref, "nan/deepseek-v4-flash");
	}
});

test("voice-ai model without thinking keeps that model", () => {
	const dir = mkdtempSync(join(tmpdir(), "gv-vai-nothink-"));
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "OpenSource",
			profiles: {
				OpenSource: {
					orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" },
					"voice-ai": { model: "nan/mimo-v2.6-flash" },
				},
			},
		}),
	);
	const res = resolveNarratorFromProfiles({
		configHome: dir,
		env: {},
		activeThinking: "high",
	});
	assert.equal(res.status, "ready");
	if (res.status === "ready") {
		assert.equal(res.source, "role");
		assert.equal(res.model.ref, "nan/mimo-v2.6-flash");
		assert.equal(res.model.thinking, undefined);
		assert.equal(res.orchestratorRef, "nan/deepseek-v4-flash");
	}
});

test("a fenced code answer is rewritten, not read aloud", async () => {
	const src = [
		"Para crear un índice en PostgreSQL puedes ejecutar:",
		"```sql",
		"CREATE INDEX idx_cliente_rut ON cliente(rut);",
		"```",
		"Esto mejora las consultas por RUT y agrega costo en las escrituras.",
	].join("\n");
	assert.equal(shouldPreferLiteralNarration(src), false);
	assert.match(NARRATION_SYSTEM_PROMPT, /No inventes/);
	let calls = 0;
	const spoken = "En PostgreSQL puedes acelerar las búsquedas por RUT creando un índice. Te dejé el comando en pantalla. Los índices también cuestan en las escrituras.";
	const host: NarrationModelHost = {
		find: () => ({ id: "gpt" }),
		hasConfiguredAuth: () => true,
		complete: async () => {
			calls += 1;
			return { content: [{ type: "text", text: spoken }] };
		},
	};
	const adapter = createVoiceNarrationAdapter({
		config: {
			enabled: true,
			role: "voice-ai",
			onError: "deterministic",
			style: "natural",
			timeoutMs: 5_000,
			maxInputChars: 4000,
		},
		host,
		resolveOverride: () => ({
			status: "ready",
			source: "active_model_fallback",
			model: { provider: "openai", id: "gpt", ref: "openai/gpt" },
		}),
	});
	const before = src;
	const r = await adapter.narrate({ text: src });
	assert.equal(src, before);
	assert.equal(calls, 1);
	assert.equal(r.ok, true);
	if (r.ok && r.path === "llm") {
		assert.equal(r.text, spoken);
		assert.notEqual(r.text, src);
		assert.doesNotMatch(r.text, /CREATE INDEX/);
	} else {
		assert.fail(`expected llm narration, got ${JSON.stringify(r)}`);
	}
});

test("provider error is a visible deterministic fallback and does not call twice", async () => {
	let calls = 0;
	const notices: string[] = [];
	const host: NarrationModelHost = {
		find: () => ({ id: "gpt" }),
		hasConfiguredAuth: () => true,
		complete: async () => {
			calls += 1;
			throw new Error("provider down");
		},
	};
	const adapter = createVoiceNarrationAdapter({
		config: {
			enabled: true,
			role: "voice-ai",
			onError: "deterministic",
			style: "natural",
			timeoutMs: 5_000,
			maxInputChars: 2000,
		},
		host,
		onNotice: (message) => {
			notices.push(message);
		},
		resolveOverride: () => ({
			status: "ready",
			source: "active_model_fallback",
			model: { provider: "openai", id: "gpt", ref: "openai/gpt" },
		}),
	});
	const src = "El índice cubre la columna rut y no está creado todavía.";
	const r = await adapter.narrate({ text: src });
	assert.equal(calls, 1);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.path, "deterministic");
		assert.equal(r.text, src);
		assert.match(r.reason, /api_error/);
	}
	assert.equal(notices.length, 1);
	assert.match(notices[0] ?? "", /api_error/);
});

test("disabled narration does not call the model", async () => {
	let calls = 0;
	const host: NarrationModelHost = {
		find: () => ({ id: "gpt" }),
		complete: async () => {
			calls += 1;
			return { content: [{ type: "text", text: "no" }] };
		},
	};
	const adapter = createVoiceNarrationAdapter({
		config: {
			enabled: false,
			role: "voice-ai",
			onError: "deterministic",
			style: "natural",
			timeoutMs: 1000,
			maxInputChars: 500,
		},
		host,
	});
	const r = await adapter.narrate({ text: "Texto escrito que debe quedar igual." });
	assert.equal(calls, 0);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.path, "deterministic");
});

test("tool and thinking parts are not narration input", () => {
	const decision = classifyAssistantForSpeech(
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "internal plan" },
				{ type: "toolCall", name: "bash" },
			],
		},
		"completed",
	);
	assert.equal(decision.speak, false);
	assert.equal(decision.text, "");
});

test("status labels reflect host and narrator source", () => {
	const pi = formatVoiceAiStatus({
		hostKind: "pi-standalone",
		enabled: true,
		activationSource: "automatic",
		streaming: "after_settle",
		resolution: {
			status: "ready",
			source: "active_model_fallback",
			model: { provider: "openai", id: "gpt", ref: "openai/gpt" },
			note: "pi-standalone uses the active Pi model",
		},
		orchestratorLabel: "openai/gpt",
		diagnostics: { enabled: true, lastPath: "llm", lastInvokedRef: "openai/gpt", lastLatencyMs: 40 },
	});
	assert.match(pi, /Host: pi-standalone/);
	assert.match(pi, /Narrator source: active-pi-model/);
	assert.match(pi, /Narrator: openai\/gpt/);
	assert.match(pi, /Narration mode: llm-rewrite/);
	assert.match(pi, /Last result: llm/);

	const gs = formatVoiceAiStatus({
		hostKind: "gs-isolated",
		enabled: true,
		activationSource: "automatic",
		streaming: "after_settle",
		resolution: {
			status: "ready",
			source: "role",
			profileName: "OpenSource",
			orchestratorRef: "nan/deepseek-v4-flash",
			model: { provider: "nan", id: "mimo-v2.6-flash", ref: "nan/mimo-v2.6-flash", thinking: "low" },
		},
		orchestratorLabel: "nan/deepseek-v4-flash",
		diagnostics: { enabled: true },
	});
	assert.match(gs, /Host: gentle-shell/);
	assert.match(gs, /Profile: OpenSource/);
	assert.match(gs, /Narrator source: profile-role/);
	assert.match(gs, /Orchestrator: nan\/deepseek-v4-flash/);
	assert.match(gs, /Narrator: nan\/mimo-v2.6-flash/);

	const fallback = formatVoiceAiStatus({
		hostKind: "gs-bundled",
		enabled: true,
		activationSource: "automatic",
		streaming: "after_settle",
		resolution: {
			status: "ready",
			source: "orchestrator_fallback",
			model: { provider: "nan", id: "deepseek-v4-flash", ref: "nan/deepseek-v4-flash" },
			note: "voice-ai has no model configured",
		},
		orchestratorLabel: "nan/deepseek-v4-flash",
		diagnostics: { enabled: true },
	});
	assert.match(fallback, /Narrator source: orchestrator-fallback/);
	assert.match(fallback, /Narration mode: llm-rewrite/);
});

test("widget shows NARRATING while the second call is in flight", () => {
	const line = resolveChromeActivity(
		initialVoiceState({ enabled: true, phase: "awaiting_agent" }),
		{ narrating: true },
	);
	assert.equal(line, "NARRATING");
	const working = resolveChromeActivity(
		initialVoiceState({ enabled: true, phase: "awaiting_agent" }),
		{},
	);
	assert.equal(working, "WORKING");
});

const createdProfileDirs: string[] = [];
after(() => {
	for (const dir of createdProfileDirs) rmSync(dir, { recursive: true, force: true });
});

function profilesDir(prefix: string, profile: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	createdProfileDirs.push(dir);
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, active: "P", profiles: { P: profile } }),
	);
	return dir;
}

test("resolveNarrator: role absent uses the session model, not the saved orchestrator", () => {
	const dir = profilesDir("gv-vai-session-", { orchestrator: { model: "nan/deepseek-v4-flash" } });
	const res = resolveNarratorFromProfiles({
		configHome: dir,
		activeModel: { provider: "openai-codex", id: "gpt-6.1-sol" },
		activeThinking: "medium",
	});
	assert.equal(res.status, "ready");
	if (res.status === "ready") {
		assert.equal(res.source, "active_model_fallback");
		assert.equal(res.model.ref, "openai-codex/gpt-6.1-sol");
		assert.equal(res.profileName, "P");
	}
});

test("resolveNarrator: an empty voice-ai role uses the session model", () => {
	const dir = profilesDir("gv-vai-empty-", { orchestrator: { model: "nan/deepseek-v4-flash" }, "voice-ai": {} });
	const res = resolveNarratorFromProfiles({
		configHome: dir,
		activeModel: { provider: "openai-codex", id: "gpt-6.1-sol" },
	});
	assert.equal(res.status, "ready");
	if (res.status === "ready") {
		assert.equal(res.source, "active_model_fallback");
		assert.equal(res.model.ref, "openai-codex/gpt-6.1-sol");
		assert.equal(res.note, "voice-ai has no model configured");
	}
});

test("resolveNarrator: an assigned voice-ai role still wins over the session model", () => {
	const dir = profilesDir("gv-vai-role-", { "voice-ai": { model: "nan/mimo-v2.6-flash" } });
	const res = resolveNarratorFromProfiles({
		configHome: dir,
		activeModel: { provider: "openai-codex", id: "gpt-6.1-sol" },
	});
	assert.equal(res.status, "ready");
	if (res.status === "ready") assert.equal(res.model.ref, "nan/mimo-v2.6-flash");
});

test("adapter: a provider error is reported with the model, not as an empty reply", async () => {
	const dir = profilesDir("gv-vai-401-", { "voice-ai": { model: "nan/mimo-v2.6-flash" } });
	const notices: string[] = [];
	const adapter = createVoiceNarrationAdapter({
		config: {
			enabled: true,
			role: "voice-ai",
			onError: "deterministic",
			style: "natural",
			timeoutMs: 5_000,
			maxInputChars: 2000,
			configHome: dir,
		},
		host: {
			find: () => ({ id: "mimo-v2.6-flash" }),
			hasConfiguredAuth: () => true,
			complete: async () => ({
				content: [],
				stopReason: "error",
				errorMessage: '401: {"message":"Invalid API key."}',
			}),
		},
		onNotice: (message) => notices.push(message),
	});
	const r = await adapter.narrate({ text: "Hola, qué gusto saludarte hoy." });
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.path, "deterministic");
		assert.equal(r.reason, "provider_error:nan/mimo-v2.6-flash");
		assert.equal(r.text, "Hola, qué gusto saludarte hoy.");
	}
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /nan\/mimo-v2\.6-flash failed \(401: .*Invalid API key/);
	assert.doesNotMatch(notices[0]!, /empty_llm_response/);
});
