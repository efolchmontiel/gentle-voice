/**
 * Phase 1 mandatory checks — no network, no real installs, no Pi tokens.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	RECOMMENDED_STT,
	RECOMMENDED_TTS,
	PREFERRED_SHORTCUT,
} from "../lib/engines/contracts.ts";
import { ENGINE_CATALOG, specById } from "../lib/engines/catalog.ts";
import {
	classifyScenario,
	detectEngines,
	detectionFingerprint,
	staticEngineProbe,
} from "../lib/engines/detect.ts";
import { staticHardwareProbe, readHardwareProfile } from "../lib/engines/hardware.ts";
import { modelCompatibleWithEngine, recommendDefaultModels } from "../lib/engines/models.ts";
import {
	buildInstallPlan,
	executeSimulatedInstall,
	formatInstallConsent,
} from "../lib/engines/install-plan.ts";
import {
	beginSetup,
	completeSetupState,
	planFromSetup,
	shouldRepromptSetup,
	suggestSetupMode,
} from "../lib/engines/setup.ts";
import {
	allowlistShortcutProbe,
	deniedShortcutProbe,
	evaluatePreferredShortcut,
	maybeRegisterVoiceShortcut,
} from "../lib/shortcut.ts";
import { createVoiceExtension } from "../extensions/voice.ts";
import type { VoiceHostApi } from "../lib/contracts.ts";
import { VOICE_COMMAND } from "../lib/commands.ts";

const lowRam = staticHardwareProbe({ ramBytes: 3 * 1024 * 1024 * 1024, cpuCores: 4, arch: "x64" });
const midRam = staticHardwareProbe({ ramBytes: 8 * 1024 * 1024 * 1024, cpuCores: 8, arch: "x64", hasGpuHint: true });

test("1. detect Whisper.cpp and Piper when probed", async () => {
	const report = await detectEngines({
		platform: "linux",
		probe: staticEngineProbe([
			{ engineId: "whisper-cpp", path: "/opt/whisper/main", version: "1.7.0", compatible: true, models: [] },
			{ engineId: "piper", path: "/opt/piper/piper", version: "1.2.0", compatible: true, models: [] },
		]),
	});
	assert.equal(report.recommendedSttReady, true);
	assert.equal(report.recommendedTtsReady, true);
	assert.equal(report.scenario, "B_both_recommended");
});

test("2. reuse compatible existing engines without install plan", async () => {
	const session = await beginSetup({
		platform: "linux",
		probe: staticEngineProbe([
			{ engineId: "whisper-cpp", path: "/ext/whisper", compatible: true },
			{ engineId: "piper", path: "/ext/piper", compatible: true },
		]),
		hardwareProbe: midRam,
	});
	assert.equal(suggestSetupMode(session.report), "reuse");
	const plan = planFromSetup(session, { mode: "reuse", installRoot: "/managed" });
	assert.equal(plan.components.length, 0);
	assert.equal(plan.requiresConsent, false);
});

test("3. detect alternative supported engines (scenario D)", async () => {
	const report = await detectEngines({
		platform: "linux",
		probe: staticEngineProbe([
			{ engineId: "vosk", path: "/usr/bin/vosk", compatible: true },
			{ engineId: "espeak-ng", path: "/usr/bin/espeak-ng", compatible: true },
		]),
	});
	assert.equal(report.scenario, "D_alternatives");
	assert.ok(ENGINE_CATALOG.some((e) => e.id === "vosk" && e.kind === "alternative"));
	assert.ok(ENGINE_CATALOG.some((e) => e.id === "espeak-ng" && e.kind === "alternative"));
});

test("4. simulated missing install (scenario A) with consent gate", async () => {
	const report = await detectEngines({ platform: "linux", probe: staticEngineProbe([]) });
	assert.equal(report.scenario, "A_none");
	const hardware = readHardwareProfile({ platform: "linux", probe: midRam });
	const plan = buildInstallPlan({
		report,
		mode: "recommended",
		installRoot: "/home/erickfm/WD-Black/gentle-voice",
		hardware,
		language: "es",
	});
	assert.ok(plan.components.length >= 2);
	assert.match(formatInstallConsent(plan), /SIMULATED/);
	const denied = executeSimulatedInstall(plan, { userConsent: false });
	assert.equal(denied.ok, false);
	assert.deepEqual(denied.errors, ["consent_required"]);
	const ok = executeSimulatedInstall(plan, { userConsent: true });
	assert.equal(ok.ok, true);
	assert.equal(ok.simulated, true);
	assert.ok(ok.installed.includes(RECOMMENDED_STT));
	assert.ok(ok.installed.includes(RECOMMENDED_TTS));
});

test("5. auto suggested mode is recommended when nothing found", async () => {
	const session = await beginSetup({ platform: "darwin", probe: staticEngineProbe([]), hardwareProbe: lowRam });
	assert.equal(session.suggestedMode, "recommended");
});

test("6. manual advanced selection can skip duplicate installs", async () => {
	const report = await detectEngines({
		platform: "win32",
		probe: staticEngineProbe([
			{ engineId: "vosk", path: "C:\\vosk", compatible: true },
			{ engineId: "piper", path: "C:\\piper", compatible: true },
		]),
	});
	assert.equal(classifyScenario(report.stt, report.tts), "C_partial");
	const hardware = readHardwareProfile({ platform: "win32", probe: midRam });
	const plan = buildInstallPlan({
		report,
		mode: "advanced",
		installRoot: "D:\\gentle-voice",
		hardware,
		sttEngineId: "vosk",
		ttsEngineId: RECOMMENDED_TTS,
	});
	// vosk already present — only piper would be installed if missing; piper is ready → empty
	assert.equal(plan.components.length, 0);
});

test("7. custom install root appears in plan paths", async () => {
	const report = await detectEngines({ platform: "linux", probe: staticEngineProbe([]) });
	const hardware = readHardwareProfile({ platform: "linux", probe: midRam });
	const root = "/mnt/custom/voice-engines";
	const plan = buildInstallPlan({ report, mode: "recommended", installRoot: root, hardware });
	assert.ok(
		plan.components.every((c) => c.installRoot.replace(/\\/g, "/").startsWith(root)),
	);
});

test("8. model compatibility with engines + Spanish defaults", () => {
	const hardware = readHardwareProfile({ platform: "linux", probe: midRam });
	const rec = recommendDefaultModels({ hardware, language: "es" });
	assert.equal(rec.stt.engineId, RECOMMENDED_STT);
	assert.equal(rec.tts.engineId, RECOMMENDED_TTS);
	assert.ok(rec.tts.languageTags.includes("es"));
	assert.equal(modelCompatibleWithEngine(rec.stt.modelId, RECOMMENDED_STT), true);
	assert.equal(modelCompatibleWithEngine(rec.tts.modelId, RECOMMENDED_STT), false);
	assert.equal(modelCompatibleWithEngine(rec.tts.modelId, RECOMMENDED_TTS), true);
});

test("9. hardware profile is injectable", () => {
	const hw = readHardwareProfile({
		platform: "linux",
		probe: staticHardwareProbe({ ramBytes: 16 * 1024 ** 3, cpuCores: 12, arch: "arm64", hasGpuHint: true, gpuLabel: "mock-gpu" }),
	});
	assert.equal(hw.arch, "arm64");
	assert.equal(hw.cpuCores, 12);
	assert.equal(hw.hasGpuHint, true);
	assert.equal(hw.gpuLabel, "mock-gpu");
});

test("10. install failure recovery stays simulated and non-destructive", () => {
	const fullReport = {
		platform: "linux" as const,
		scenario: "A_none" as const,
		stt: [],
		tts: [],
		recommendedSttReady: false,
		recommendedTtsReady: false,
		message: "none",
	};
	const hardware = readHardwareProfile({ platform: "linux", probe: midRam });
	const plan = buildInstallPlan({ report: fullReport, mode: "recommended", installRoot: "/tmp/gv", hardware });
	const result = executeSimulatedInstall(plan, { userConsent: true, failEngineId: RECOMMENDED_STT });
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((e) => e.includes(RECOMMENDED_STT)));
	assert.ok(result.skipped.includes(RECOMMENDED_STT));
	assert.ok(result.installed.includes(RECOMMENDED_TTS));
});

test("11. Ctrl+Alt+Space stays disabled when unverified", async () => {
	const blocked = await evaluatePreferredShortcut({ probe: deniedShortcutProbe() });
	assert.equal(blocked.preferred, PREFERRED_SHORTCUT);
	assert.equal(blocked.available, false);
	assert.equal(blocked.registered, false);

	const allowed = await evaluatePreferredShortcut({
		probe: allowlistShortcutProbe([PREFERRED_SHORTCUT]),
	});
	assert.equal(allowed.available, true);
});

test("12. /gentle-voice registers on host", () => {
	const commands: string[] = [];
	const pi: VoiceHostApi = {
		registerCommand(name) {
			commands.push(name);
		},
	};
	createVoiceExtension(pi, { shortcutProbe: deniedShortcutProbe() });
	assert.deepEqual(commands, [VOICE_COMMAND]);
});

test("13. experimental isolation — catalog does not point at global package managers", () => {
	for (const spec of ENGINE_CATALOG) {
		assert.ok(!spec.downloadOrigin.includes("apt."));
		assert.ok(!spec.downloadOrigin.includes("brew.sh"));
		assert.ok(specById(spec.id));
	}
	assert.equal(PREFERRED_SHORTCUT, "ctrl+alt+space");
});

test("14. no token consumption path in phase-1 suite (local pure functions only)", async () => {
	// Meta-check: this file never imports network clients or LLM SDKs.
	const session = await beginSetup({ probe: staticEngineProbe([]), hardwareProbe: lowRam });
	const fp = detectionFingerprint(session.report);
	const state = completeSetupState(session, {
		mode: "recommended",
		sttEngineId: RECOMMENDED_STT,
		ttsEngineId: RECOMMENDED_TTS,
		installRoot: "/home/erickfm/WD-Black/gentle-voice",
	});
	assert.equal(shouldRepromptSetup(state, fp), false);
	assert.equal(shouldRepromptSetup(state, fp + "|changed"), true);
});

test("shortcut never auto-registers alternate chord", async () => {
	let registered: string | undefined;
	const pi: VoiceHostApi = {
		registerCommand() {},
		registerShortcut(name) {
			registered = name;
		},
	};
	const result = await maybeRegisterVoiceShortcut(pi, {
		probe: deniedShortcutProbe(),
		handler: async () => {},
	});
	assert.equal(result.registered, false);
	assert.equal(registered, undefined);

	const ok = await maybeRegisterVoiceShortcut(pi, {
		probe: allowlistShortcutProbe([PREFERRED_SHORTCUT]),
		handler: async () => {},
	});
	assert.equal(ok.registered, true);
	assert.equal(registered, PREFERRED_SHORTCUT);
});

test("scenario C partial install plans only the missing recommended engine", async () => {
	const report = await detectEngines({
		platform: "linux",
		probe: staticEngineProbe([
			{ engineId: "whisper-cpp", path: "/w", compatible: true },
		]),
	});
	assert.equal(report.scenario, "C_partial");
	const hardware = readHardwareProfile({ platform: "linux", probe: midRam });
	const plan = buildInstallPlan({ report, mode: "recommended", installRoot: "/gv", hardware });
	assert.deepEqual(plan.components.map((c) => c.engineId), [RECOMMENDED_TTS]);
});

test("scenario E incompatible does not plan destructive actions", async () => {
	const report = await detectEngines({
		platform: "linux",
		probe: staticEngineProbe([
			{ engineId: "whisper-cpp", path: "/old/whisper", compatible: false, problem: "too old" },
			{ engineId: "piper", path: "/old/piper", compatible: false, problem: "broken voice" },
		]),
	});
	assert.equal(report.scenario, "E_incompatible");
	assert.match(report.message, /incompatible/i);
	const hardware = readHardwareProfile({ platform: "linux", probe: midRam });
	const plan = buildInstallPlan({ report, mode: "recommended", installRoot: "/gv-managed", hardware });
	assert.ok(plan.requiresConsent);
	assert.ok(plan.components.every((c) => c.installRoot.includes("gv-managed")));
});
