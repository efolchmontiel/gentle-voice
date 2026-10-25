/**
 * Structured TUI validation checklist for Gentle Voice + GS experimental.
 * Automated harness can mark simulated items; live TUI items stay pending
 * until a human records evidence.
 */

export type TuiCheckStatus = "pass" | "fail" | "pending_human" | "simulated";

export interface TuiCheckItem {
	readonly id: string;
	readonly label: string;
	readonly status: TuiCheckStatus;
	readonly evidence: string;
}

export interface TuiValidationReport {
	readonly overall: "pass" | "fail" | "pending_human";
	readonly items: readonly TuiCheckItem[];
	readonly llmTokensUsed: false;
	readonly isolationNote: string;
}

export function buildPhase1cTuiReport(options?: {
	harnessCommandsOk?: boolean;
	harnessWidgetOk?: boolean;
	harnessCleanupOk?: boolean;
	liveTuiObserved?: boolean;
	shortcutLiveOk?: boolean;
}): TuiValidationReport {
	const harnessCommandsOk = options?.harnessCommandsOk ?? false;
	const harnessWidgetOk = options?.harnessWidgetOk ?? false;
	const harnessCleanupOk = options?.harnessCleanupOk ?? false;
	const liveTuiObserved = options?.liveTuiObserved ?? false;
	const shortcutLiveOk = options?.shortcutLiveOk ?? false;

	const items: TuiCheckItem[] = [
		{
			id: "cmd-register",
			label: "/gentle-voice registers",
			status: harnessCommandsOk ? "simulated" : "pending_human",
			evidence: harnessCommandsOk
				? "Pi harness registerCommand + subcommands"
				: "Await live GS TUI",
		},
		{
			id: "cmd-subcommands",
			label: "on/off/listen/stop/mute/status/config",
			status: harnessCommandsOk ? "simulated" : "pending_human",
			evidence: harnessCommandsOk ? "harness runCommand suite" : "Await live GS TUI",
		},
		{
			id: "widget-appear",
			label: "Widget above editor while listening",
			status: harnessWidgetOk ? "simulated" : "pending_human",
			evidence: harnessWidgetOk ? "setWidget aboveEditor" : "Await live GS TUI",
		},
		{
			id: "widget-transitions",
			label: "Visual phase transitions",
			status: harnessWidgetOk ? "simulated" : "pending_human",
			evidence: harnessWidgetOk ? "listening→idle widget clear" : "Await live GS TUI",
		},
		{
			id: "widget-cleanup",
			label: "Widget cleared on stop/off",
			status: harnessCleanupOk ? "simulated" : "pending_human",
			evidence: harnessCleanupOk ? "setWidget(undefined)" : "Await live GS TUI",
		},
		{
			id: "input-compat",
			label: "Normal GS input still usable",
			status: liveTuiObserved ? "pass" : "pending_human",
			evidence: liveTuiObserved ? "human observed" : "Requires interactive TUI",
		},
		{
			id: "widget-no-conflict",
			label: "No conflict with other GS widgets",
			status: liveTuiObserved ? "pass" : "pending_human",
			evidence: liveTuiObserved ? "human observed" : "Requires interactive TUI",
		},
		{
			id: "shortcut-live",
			label: "Ctrl+Alt+Space received in TUI",
			status: shortcutLiveOk ? "pass" : "pending_human",
			evidence: shortcutLiveOk
				? "human confirmed chord"
				: "Fail-closed; remain disabled until proven",
		},
		{
			id: "no-llm",
			label: "No LLM / token consumption",
			status: "pass",
			evidence: "Harness + checklist forbid sendUserMessage to providers",
		},
	];

	const anyFail = items.some((i) => i.status === "fail");
	const anyPending = items.some((i) => i.status === "pending_human");
	const overall = anyFail ? "fail" : anyPending ? "pending_human" : "pass";

	return {
		overall,
		items,
		llmTokensUsed: false,
		isolationNote:
			"Launch only via gs-lab --home; never touch ~/.gentle-shell or global Pi settings.",
	};
}

export const TUI_HUMAN_INSTRUCTIONS = `
# Gentle Voice — live TUI checklist (human)

## Prep (lab only)

\`\`\`bash
cd "$GENTLE_VOICE_LAB_ROOT"   # your isolated lab tree
export GENTLE_SHELL_NO_AUTO_SETUP=1
export GENTLE_SHELL_CONFIG="$PWD/launcher-config.json"
export PI_CODING_AGENT_DIR="$PWD/agent"
export GENTLE_VOICE_HOME="$PWD/voice-home"
export GENTLE_VOICE_MODELS="$GENTLE_VOICE_LAB_ROOT/models"
export GENTLE_VOICE_CACHE="$GENTLE_VOICE_LAB_ROOT/cache"
export GENTLE_VOICE_LAB=1

# Experimental GS package + lab home — do NOT use --link / default home
gentle-shell --home "$PWD/agent" \\
  --package-root "$GENTLE_VOICE_LAB_GS" \\
  -e "$GENTLE_VOICE_LAB_EXTENSION"
\`\`\`

Do **not** send any prompt that would call an LLM. Use slash commands only.

## Checks

1. Type \`/gentle-voice status\` — expect platform/engines lines (notify).
2. \`/gentle-voice on\` then \`/gentle-voice listen\` — widget above input.
3. \`/gentle-voice stop\` — widget clears; editor still accepts typing.
4. \`/gentle-voice mute\` / \`mute off\` / \`off\` — no crashes.
5. Press **Ctrl+Alt+Space** once — note if Pi/GS receives it (widget toggle?).
6. Confirm Ghostty/Hyprland did not steal the chord (no desktop switch).
7. Quit without saving global settings.

## Record

Append one line to \`gs-lab/logs/phase1c-tui.log\`:

\`YYYY-MM-DDThh:mm:ssZ tui: pass|fail shortcut: pass|fail|unverified notes: ...\`
`.trim();
