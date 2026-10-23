/**
 * WSL2 + WSLg microphone bridge. Fake IO only: no real systemctl, apt, or PipeWire.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	WSL_APT_COMMAND,
	WSL_PACTL_TIMEOUT_MS,
	WSL_SYSTEMCTL_ENABLE,
	WSL_SYSTEMCTL_RESTART,
	createNodeWslAudioIo,
	driveWslAudioBridge,
	planWslAudioBridge,
	wslBridgeConfigPath,
	wslTunnelConfig,
	type WslAudioIo,
} from "../lib/adapters/wsl-audio.ts";

const HOME = "/home/tester";
const CONF_DIR = `${HOME}/.config/pipewire/pipewire.conf.d`;
const OUR_CONF = `${CONF_DIR}/gentle-voice-wslg.conf`;

interface FakeState {
	osrelease?: string;
	files: Map<string, string>;
	sources?: string;
	/** `wpctl status` output; undefined means wpctl failed (PipeWire down). */
	wpctl?: string;
	systemctlOk?: boolean;
	runs: string[];
	writes: string[];
}

function fakeIo(state: FakeState): WslAudioIo {
	return {
		readText: (path) => state.files.get(path) ?? (path === "/proc/sys/kernel/osrelease" ? state.osrelease : undefined),
		exists: (path) => state.files.has(path),
		listDir: (dir) =>
			[...state.files.keys()]
				.filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
				.map((p) => p.slice(dir.length + 1)),
		run: async (cmd, args) => {
			state.runs.push([cmd, ...args].join(" "));
			if (cmd === "pactl") {
				return state.sources === undefined
					? { ok: false, stdout: "" }
					: { ok: true, stdout: state.sources };
			}
			if (cmd === "wpctl") {
				return state.wpctl === undefined ? { ok: false, stdout: "" } : { ok: true, stdout: state.wpctl };
			}
			if (cmd === "systemctl") return { ok: state.systemctlOk !== false, stdout: "", stderr: state.systemctlOk === false ? "Failed to connect to bus" : "" };
			return { ok: false, stdout: "" };
		},
		writeText: async (path, content) => {
			state.writes.push(path);
			state.files.set(path, content);
		},
	};
}

const WPCTL_WITH_MIC = "Audio\n ├─ Devices:\n │  \n ├─ Sinks:\n │  *   40. WSLg Speaker  [vol: 1.00]\n │  \n ├─ Sources:\n │  *   38. WSLg Microphone  [vol: 1.00]\n │  \n ├─ Source endpoints:\n │  \n └─ Streams:\n\nVideo\n ├─ Sources:\n │  \n";
const WPCTL_NO_MIC = "Audio\n ├─ Devices:\n │  \n ├─ Sinks:\n │  \n ├─ Sources:\n │  \n ├─ Source endpoints:\n │  \n └─ Streams:\n\nVideo\n ├─ Sources:\n │  *   50. Some Camera\n";

const RDP_SOURCES = "1\tRDPSink.monitor\tmodule-rdp-sink.c\ts16le 2ch 44100Hz\tSUSPENDED\n2\tRDPSource\tmodule-rdp-source.c\ts16le 1ch 44100Hz\tSUSPENDED\n";

function wslState(overrides: Partial<FakeState> = {}): FakeState {
	return {
		osrelease: "6.6.87.2-microsoft-standard-WSL2",
		files: new Map([
			["/mnt/wslg/PulseServer", ""],
			["/usr/bin/pw-record", ""],
			["/usr/bin/wpctl", ""],
			["/usr/bin/pactl", ""],
		]),
		sources: RDP_SOURCES,
		wpctl: WPCTL_NO_MIC,
		runs: [],
		writes: [],
		...overrides,
	};
}

const env: NodeJS.ProcessEnv = { HOME };

function host(confirmAnswer?: boolean) {
	const notes: { message: string; level?: string }[] = [];
	const confirms: { title: string; message: string }[] = [];
	return {
		notes,
		confirms,
		notify: (message: string, level?: "info" | "warning" | "error") => {
			notes.push({ message, level });
		},
		...(confirmAnswer === undefined
			? {}
			: {
				confirm: async (title: string, message: string) => {
					confirms.push({ title, message });
					return confirmAnswer;
				},
			}),
	};
}

test("native Linux is not touched: no commands, no writes, no notices", async () => {
	const state = wslState({ osrelease: "6.8.0-45-generic" });
	const h = host(true);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.deepEqual(plan, { kind: "not-wsl" });
	assert.deepEqual(state.runs, []);
	assert.deepEqual(state.writes, []);
	assert.deepEqual(h.notes, []);
	assert.deepEqual(h.confirms, []);
});

test("WSL is detected from WSL_DISTRO_NAME even when osrelease is unreadable", async () => {
	const state = wslState({ osrelease: undefined });
	const plan = await planWslAudioBridge({ HOME, WSL_DISTRO_NAME: "Ubuntu" }, fakeIo(state));
	assert.equal(plan.kind, "bridge-missing");
});

test("WSL without WSLg explains that WSLg is required and writes nothing", async () => {
	const state = wslState();
	state.files.delete("/mnt/wslg/PulseServer");
	const h = host(true);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.deepEqual(plan, { kind: "no-wslg" });
	assert.deepEqual(state.writes, []);
	assert.equal(h.notes.length, 1);
	assert.equal(h.notes[0].level, "warning");
	assert.match(h.notes[0].message, /WSLg is not available/);
	assert.match(h.notes[0].message, /wsl --update/);
});

test("missing PipeWire packages print the exact apt command and never run sudo", async () => {
	const state = wslState();
	state.files.delete("/usr/bin/pw-record");
	const h = host(true);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.deepEqual(plan, { kind: "packages-missing", command: WSL_APT_COMMAND });
	assert.equal(WSL_APT_COMMAND, "sudo apt install pipewire pipewire-bin wireplumber pulseaudio-utils");
	assert.ok(!state.runs.some((r) => r.startsWith("sudo") || r.startsWith("apt")));
	assert.deepEqual(state.writes, []);
	assert.deepEqual(h.confirms, []);
	assert.match(h.notes[0].message, /sudo apt install pipewire pipewire-bin wireplumber pulseaudio-utils/);
	assert.match(h.notes[0].message, /\/gentle:voice setup/);
});

test("missing RDPSource points to the Windows microphone permission", async () => {
	const state = wslState({ sources: "1\tRDPSink.monitor\tmodule-rdp-sink.c\ts16le 2ch 44100Hz\tSUSPENDED\n" });
	const h = host(true);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.deepEqual(plan, { kind: "no-mic-source" });
	assert.deepEqual(state.writes, []);
	assert.match(h.notes[0].message, /RDPSource/);
	assert.match(h.notes[0].message, /Privacy & security → Microphone/);
	assert.match(h.notes[0].message, /wsl --shutdown/);
});

test("an unresponsive WSLg audio server is not blamed on Windows permissions", async () => {
	const state = wslState({ sources: undefined });
	const h = host(true);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.deepEqual(plan, { kind: "wslg-unresponsive" });
	assert.deepEqual(state.writes, []);
	assert.deepEqual(h.confirms, []);
	assert.equal(h.notes.length, 1);
	assert.match(h.notes[0].message, /WSLg audio server is not responding/);
	assert.match(h.notes[0].message, /wsl --shutdown/);
	assert.doesNotMatch(h.notes[0].message, /Privacy/);
});

test("pactl gets a short timeout so a hung WSLg server cannot stall setup", async () => {
	const state = wslState();
	const seen: (number | undefined)[] = [];
	const io = fakeIo(state);
	const run = io.run;
	await planWslAudioBridge(env, {
		...io,
		run: async (cmd, args, options) => {
			if (cmd === "pactl") seen.push(options?.timeoutMs);
			return run(cmd, args, options);
		},
	});
	assert.deepEqual(seen, [WSL_PACTL_TIMEOUT_MS]);
	assert.ok(WSL_PACTL_TIMEOUT_MS <= 5_000);
});

test("a live WSLg source configured outside the user drop-ins counts as ready", async () => {
	const state = wslState({ wpctl: WPCTL_WITH_MIC });
	const h = host(true);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.deepEqual(plan, { kind: "ready" });
	assert.deepEqual(state.writes, []);
	assert.deepEqual(h.confirms, []);
	assert.deepEqual(h.notes, []);
	assert.ok(!state.runs.some((r) => r.startsWith("systemctl")));
});

test("a live WSLg source is ready even while WSLg's server hangs new pactl clients", async () => {
	const state = wslState({ wpctl: WPCTL_WITH_MIC, sources: undefined });
	const h = host(true);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.deepEqual(plan, { kind: "ready" });
	assert.ok(!state.runs.some((r) => r.startsWith("pactl")));
	assert.deepEqual(h.notes, []);
});

test("an existing drop-in that already tunnels WSLg counts as ready", async () => {
	const state = wslState({ wpctl: WPCTL_WITH_MIC });
	state.files.set(`${CONF_DIR}/wslg-tunnel.conf`, 'pulse.server.address = "unix:/mnt/wslg/PulseServer"');
	const h = host(true);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.deepEqual(plan, { kind: "ready" });
	assert.deepEqual(state.writes, []);
	assert.deepEqual(h.confirms, []);
	assert.deepEqual(h.notes, []);
});

test("a bridge file whose tunnel never loaded offers a service restart, not a rewrite", async () => {
	const state = wslState({ wpctl: WPCTL_NO_MIC });
	state.files.set(OUR_CONF, wslTunnelConfig());
	const h = host(true);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.deepEqual(plan, { kind: "ready" });
	assert.deepEqual(state.writes, []);
	assert.equal(h.confirms.length, 1);
	assert.match(h.confirms[0].message, /systemctl --user restart pipewire\.service wireplumber\.service/);
	// enable too: a first attempt may have written the drop-in and then failed to enable.
	assert.deepEqual(state.runs.filter((r) => r.startsWith("systemctl")), [
		WSL_SYSTEMCTL_ENABLE.join(" "),
		WSL_SYSTEMCTL_RESTART.join(" "),
	]);
});

test("a bridge with PipeWire down is inactive and declining restarts nothing", async () => {
	const state = wslState({ wpctl: undefined });
	state.files.set(OUR_CONF, wslTunnelConfig());
	const h = host(false);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.equal(plan.kind, "bridge-inactive");
	assert.deepEqual(state.writes, []);
	assert.ok(!state.runs.some((r) => r.startsWith("systemctl")));
	assert.match(h.notes[0].message, /systemctl --user restart pipewire\.service wireplumber\.service/);
});

test("accepting the bridge writes the drop-in and enables then restarts user services", async () => {
	const state = wslState();
	const h = host(true);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.deepEqual(plan, { kind: "ready" });
	assert.equal(h.confirms.length, 1);
	assert.match(h.confirms[0].message, /gentle-voice-wslg\.conf/);
	assert.match(h.confirms[0].message, /systemctl --user enable --now/);
	assert.deepEqual(state.writes, [OUR_CONF]);
	assert.equal(state.files.get(OUR_CONF), wslTunnelConfig());
	assert.deepEqual(state.runs.filter((r) => r.startsWith("systemctl")), [
		WSL_SYSTEMCTL_ENABLE.join(" "),
		WSL_SYSTEMCTL_RESTART.join(" "),
	]);
	assert.equal(h.notes.at(-1)?.level, "info");
	assert.match(h.notes.at(-1)!.message, /WSLg Microphone/);
});

test("declining the bridge writes nothing and prints the manual steps", async () => {
	const state = wslState();
	const h = host(false);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.equal(plan.kind, "bridge-missing");
	assert.deepEqual(state.writes, []);
	assert.ok(!state.runs.some((r) => r.startsWith("systemctl")));
	assert.match(h.notes[0].message, /gentle-voice-wslg\.conf/);
	assert.match(h.notes[0].message, /systemctl --user enable --now/);
});

test("without a confirm UI the bridge is never written", async () => {
	const state = wslState();
	const h = host();
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.equal(plan.kind, "bridge-missing");
	assert.deepEqual(state.writes, []);
	assert.equal(h.notes[0].level, "warning");
});

test("a systemctl failure reports the systemd requirement and is not ready", async () => {
	const state = wslState({ systemctlOk: false });
	const h = host(true);
	const plan = await driveWslAudioBridge(h, env, fakeIo(state));
	assert.equal(plan.kind, "services-failed");
	assert.deepEqual(state.writes, [OUR_CONF]);
	assert.equal(h.notes.at(-1)?.level, "warning");
	assert.match(h.notes.at(-1)!.message, /systemd=true/);
	assert.match(h.notes.at(-1)!.message, /Failed to connect to bus/);
});

test("bridge path follows XDG_CONFIG_HOME", () => {
	assert.equal(
		wslBridgeConfigPath({ HOME, XDG_CONFIG_HOME: "/tmp/xdg" }),
		"/tmp/xdg/pipewire/pipewire.conf.d/gentle-voice-wslg.conf",
	);
	assert.equal(wslBridgeConfigPath(env), OUR_CONF);
});

test("bridge path is never relative when HOME is empty", async () => {
	const { isAbsolute } = await import("node:path");
	assert.ok(isAbsolute(wslBridgeConfigPath({ HOME: "" })));
	assert.ok(isAbsolute(wslBridgeConfigPath({})));
});

test("a command that ignores its timeout signal and exits 0 is still a failure", async () => {
	const io = createNodeWslAudioIo();
	const started = Date.now();
	const result = await io.run(
		process.execPath,
		["-e", "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 10000);"],
		{ timeoutMs: 300 },
	);
	assert.equal(result.ok, false);
	assert.match(result.stderr ?? "", /timed out after 300 ms/);
	assert.ok(Date.now() - started < 5000);
});

test("a command that succeeds within its timeout is ok", async () => {
	const io = createNodeWslAudioIo();
	const result = await io.run(process.execPath, ["-e", "process.stdout.write('hi')"], { timeoutMs: 5000 });
	assert.deepEqual({ ok: result.ok, stdout: result.stdout }, { ok: true, stdout: "hi" });
});

test("tunnel config targets WSLg RDPSource and RDPSink", () => {
	const conf = wslTunnelConfig();
	assert.match(conf, /libpipewire-module-pulse-tunnel/);
	assert.match(conf, /tunnel\.mode = source/);
	assert.match(conf, /target\.object = "RDPSource"/);
	assert.match(conf, /tunnel\.mode = sink/);
	assert.match(conf, /target\.object = "RDPSink"/);
	assert.match(conf, /unix:\/mnt\/wslg\/PulseServer/);
});

test("both tunnels are nofail so a down WSLg server cannot keep PipeWire from starting", () => {
	const conf = wslTunnelConfig();
	assert.equal(conf.match(/libpipewire-module-pulse-tunnel/g)?.length, 2);
	assert.equal(conf.match(/flags = \[ nofail \]/g)?.length, 2);
});

test("conversation setup prepares capture before it checks the microphone", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { completeConversationSetup } = await import("../lib/runtime/conversation-setup.ts");
	const root = await mkdtemp(join(tmpdir(), "gv-wsl-"));
	try {
		const order: string[] = [];
		const caps = await completeConversationSetup(
			{
				notify: () => {},
				confirm: async () => false,
				prepareCapture: async () => {
					order.push("prepare");
				},
				captureReady: async () => {
					order.push("capture");
					return true;
				},
			},
			{ HOME: root, XDG_DATA_HOME: join(root, "xdg"), XDG_CONFIG_HOME: join(root, "config") },
			{ ttsInstalled: true, ttsReady: true, ttsActive: true, sttReady: true, playbackReady: true },
		);
		assert.deepEqual(order, ["prepare", "capture"]);
		assert.equal(caps.captureReady, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a failing capture preparation is reported and setup still completes", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { completeConversationSetup } = await import("../lib/runtime/conversation-setup.ts");
	const root = await mkdtemp(join(tmpdir(), "gv-wsl-"));
	try {
		const notes: string[] = [];
		const caps = await completeConversationSetup(
			{
				notify: (message) => notes.push(message),
				confirm: async () => false,
				prepareCapture: async () => {
					throw new Error("pactl exploded");
				},
				captureReady: async () => false,
			},
			{ HOME: root, XDG_DATA_HOME: join(root, "xdg"), XDG_CONFIG_HOME: join(root, "config") },
			{ ttsInstalled: true, ttsReady: true, ttsActive: true, sttReady: true, playbackReady: true },
		);
		assert.equal(caps.captureReady, false);
		assert.ok(notes.some((n) => n === "Microphone preparation failed (pactl exploded)."));
		assert.match(notes.at(-1)!, /^Gentle Voice setup\n/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
