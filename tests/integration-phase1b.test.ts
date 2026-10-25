/**
 * Phase 1B — Pi API harness + real detection (no LLM tokens, no downloads).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceExtension, VOICE_WIDGET_KEY } from "../extensions/voice.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";
import { collectShortcutConflictEvidence } from "../lib/lab/shortcut-conflicts.ts";
import {
	createFilesystemEngineProbe,
	isSelectableEngine,
	operationalLabel,
	ADAPTER_READY_ENGINES,
} from "../lib/engines/probe-fs.ts";
import { detectEngines } from "../lib/engines/detect.ts";
import { PREFERRED_SHORTCUT, PREFERRED_SHORTCUT_LABEL, RECOMMENDED_STT, RECOMMENDED_TTS } from "../lib/engines/contracts.ts";
import { allowlistShortcutProbe, deniedShortcutProbe, maybeRegisterVoiceShortcut } from "../lib/shortcut.ts";
import { VOICE_COMMAND } from "../lib/commands.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { appendLabLog, skipWithoutLab } from "./lab-env.ts";

async function labLog(line: string): Promise<void> {
	await appendLabLog("phase1b-access.log", line);
}

test("Pi harness: /gentle-voice registers and runs subcommands without LLM", async () => {
	const harness = createPiHostHarness();
	createVoiceExtension(harness.pi, {
		config: { ...DEFAULT_VOICE_CONFIG, enabled: false },
		shortcutProbe: deniedShortcutProbe(),
	});
	assert.ok(harness.commands.has(VOICE_COMMAND));

	await harness.runCommand(VOICE_COMMAND, "on");
	await harness.runCommand(VOICE_COMMAND, "status");
	await harness.runCommand(VOICE_COMMAND, "config");
	await harness.runCommand(VOICE_COMMAND, "listen");
	const listeningWidgets = harness.widgets.filter((w) => w.key === VOICE_WIDGET_KEY && w.content);
	assert.ok(listeningWidgets.length >= 1, "widget should appear above editor while listening");
	assert.equal(listeningWidgets.at(-1)?.placement, "aboveEditor");

	await harness.runCommand(VOICE_COMMAND, "stop");
	await harness.runCommand(VOICE_COMMAND, "mute");
	await harness.runCommand(VOICE_COMMAND, "mute off");
	await harness.runCommand(VOICE_COMMAND, "off");

	assert.ok(harness.notifies.some((n) => n.message.includes("platform=") || n.message.includes("engines.scenario=")));
	await labLog("pi-harness: commands+widget ok");
});

test("Pi harness: agent_settled does not double-fire speak when disabled", async () => {
	const harness = createPiHostHarness();
	const session = createVoiceExtension(harness.pi, {
		config: { ...DEFAULT_VOICE_CONFIG, enabled: false },
		shortcutProbe: deniedShortcutProbe(),
	});
	harness.fire("agent_settled", { aborted: false });
	harness.fire("agent_settled", { aborted: false });
	assert.equal(session.state.enabled, false);
	assert.equal(session.state.phase, "idle");
	await labLog("pi-harness: agent_settled ignored while disabled");
});

test("Pi KeyId ctrl+alt+space registers only when probe allows", async () => {
	const harness = createPiHostHarness();
	const denied = await maybeRegisterVoiceShortcut(harness.pi, {
		probe: deniedShortcutProbe(),
		handler: async () => {},
	});
	assert.equal(denied.registered, false);
	assert.equal(harness.shortcuts.size, 0);

	const allowed = await maybeRegisterVoiceShortcut(harness.pi, {
		probe: allowlistShortcutProbe([PREFERRED_SHORTCUT]),
		handler: async () => {},
	});
	assert.equal(allowed.registered, true);
	assert.ok(harness.shortcuts.has(PREFERRED_SHORTCUT));
	assert.equal(PREFERRED_SHORTCUT, "ctrl+alt+space");
	assert.equal(PREFERRED_SHORTCUT_LABEL, "Ctrl+Alt+Space");
});

test("real filesystem probe: Piper + Voxtype ggml (Linux/CachyOS lab)", { skip: skipWithoutLab }, async () => {
	const probe = createFilesystemEngineProbe({
		home: "/home/erickfm",
		modelRoots: [
			"/home/erickfm/.local/share/voxtype/models",
			"/home/erickfm/.local/share/piper-voices",
			"/home/erickfm/WD-Black/gentle-voice/models/whisper",
			"/home/erickfm/WD-Black/gentle-voice/models/piper",
		],
		pathDirs: ["/home/erickfm/.local/bin", "/usr/local/bin", "/usr/bin"],
	});
	const report = await detectEngines({ platform: "linux", probe });
	await labLog(`detect scenario=${report.scenario} stt=${report.stt.map((e) => e.spec.id + ":" + e.status).join(",")} tts=${report.tts.map((e) => e.spec.id + ":" + e.status).join(",")}`);

	const piper = report.tts.find((e) => e.spec.id === RECOMMENDED_TTS);
	assert.ok(piper, "piper should be detected");
	assert.equal(piper.status, "compatible");
	assert.ok(piper.path?.includes("piper"));
	assert.ok(piper.models.some((m) => m.path.includes("es_AR-daniela-high")));

	const whisper = report.stt.find((e) => e.spec.id === RECOMMENDED_STT);
	assert.ok(whisper, "whisper assets or binary should surface");
	// Phase 2A: lab whisper-cli under WD-Black may or may not be on PATH;
	// Voxtype ggml still detected either way.
	assert.ok(
		whisper.status === "compatible" || whisper.status === "incompatible",
		`unexpected whisper status ${whisper.status}`,
	);
	if (whisper.status === "incompatible") {
		assert.match(whisper.problem ?? "", /without_whisper_cpp_binary/);
	}
	assert.ok(whisper.models.some((m) => m.path.includes("ggml-small.bin")));

	assert.ok(ADAPTER_READY_ENGINES.has("piper"), "piper TTS adapter ready (dry-run)");
	assert.ok(ADAPTER_READY_ENGINES.has("whisper-cpp"), "whisper STT adapter ready in phase 2A");
	assert.equal(isSelectableEngine("vosk"), false);
	assert.equal(isSelectableEngine("piper"), true);
	assert.equal(operationalLabel(piper), "adapter_ready");
});

test("shortcut conflict scan is read-only and fail-closed", { skip: skipWithoutLab }, async () => {
	const evidence = await collectShortcutConflictEvidence({ home: "/home/erickfm" });
	assert.equal(evidence.preferredKeyId, "ctrl+alt+space");
	assert.equal(evidence.piKeyIdValid, true);
	assert.ok(evidence.sources.length >= 3);
	assert.match(evidence.recommendation, /disabled|fail closed|TUI/i);
	await labLog(`shortcut conflicts: osSuspected=${evidence.osConflictSuspected} sources=${evidence.sources.map((s) => basenameNote(s)).join(";")}`);
});

function basenameNote(s: { path: string; found: boolean; notes: string }): string {
	return `${s.path.split("/").pop()}:${s.found}:${s.notes}`;
}
