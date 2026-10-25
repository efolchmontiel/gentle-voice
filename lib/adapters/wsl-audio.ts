/**
 * WSL2 + WSLg microphone bridge.
 * WSLg exposes the Windows microphone only through its PulseAudio server
 * (RDPSource/RDPSink). Capture uses pw-record, so PipeWire needs a
 * pulse-tunnel into that server. This module detects the gap and, after
 * consent, writes one user-level drop-in and enables the user services.
 * It never runs sudo: missing packages are reported as an exact command.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
// WSL paths are always POSIX, even when tests run on Windows.
import { dirname, join } from "node:path/posix";

export const WSLG_PULSE_SERVER = "/mnt/wslg/PulseServer";
export const WSL_APT_COMMAND = "sudo apt install pipewire pipewire-bin wireplumber pulseaudio-utils";
export const WSL_SYSTEMCTL_ENABLE: readonly string[] = Object.freeze([
	"systemctl",
	"--user",
	"enable",
	"--now",
	"pipewire.socket",
	"pipewire.service",
	"wireplumber.service",
]);
/** Restart so an already running PipeWire loads the new drop-in. */
export const WSL_SYSTEMCTL_RESTART: readonly string[] = Object.freeze([
	"systemctl",
	"--user",
	"restart",
	"pipewire.service",
	"wireplumber.service",
]);

/** WSLg's PulseAudio server can hang; never let a probe stall setup. */
export const WSL_PACTL_TIMEOUT_MS = 4_000;
const COMMAND_TIMEOUT_MS = 15_000;

const REQUIRED_BINARIES = ["/usr/bin/pw-record", "/usr/bin/wpctl", "/usr/bin/pactl"] as const;
const BRIDGE_FILE = "gentle-voice-wslg.conf";

export type WslAudioPlan =
	| { readonly kind: "not-wsl" }
	| { readonly kind: "no-wslg" }
	| { readonly kind: "packages-missing"; readonly command: string }
	| { readonly kind: "wslg-unresponsive" }
	| { readonly kind: "no-mic-source" }
	| { readonly kind: "bridge-missing"; readonly configPath: string }
	/** Drop-in exists, but PipeWire has no audio source (tunnel not loaded, or PipeWire down). */
	| { readonly kind: "bridge-inactive" }
	| { readonly kind: "services-failed"; readonly reason: string }
	| { readonly kind: "ready" };

export interface WslAudioIo {
	readText(path: string): string | undefined;
	exists(path: string): boolean;
	listDir(dir: string): readonly string[];
	run(
		cmd: string,
		args: readonly string[],
		options?: { readonly timeoutMs?: number },
	): Promise<{ ok: boolean; stdout: string; stderr?: string }>;
	writeText(path: string, content: string): Promise<void>;
}

export interface WslAudioHost {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	confirm?(title: string, message: string): Promise<boolean>;
}

export function createNodeWslAudioIo(env: NodeJS.ProcessEnv = process.env): WslAudioIo {
	return {
		readText: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
		exists: (path) => existsSync(path),
		listDir: (dir) => {
			try {
				return readdirSync(dir);
			} catch {
				return [];
			}
		},
		// Own timer + SIGKILL: pactl catches execFile's SIGTERM and exits 0 with empty output.
		run: (cmd, args, options) =>
			new Promise((resolve) => {
				const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
				let timedOut = false;
				const child = execFile(cmd, [...args], { env }, (error, stdout, stderr) => {
					clearTimeout(timer);
					resolve({
						ok: !error && !timedOut,
						stdout: String(stdout),
						stderr: timedOut ? `timed out after ${timeoutMs} ms` : String(stderr),
					});
				});
				const timer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, timeoutMs);
			}),
		writeText: async (path, content) => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
		},
	};
}

export function isWsl(env: NodeJS.ProcessEnv, io: WslAudioIo): boolean {
	if (env.WSL_DISTRO_NAME?.trim()) return true;
	return /microsoft/i.test(io.readText("/proc/sys/kernel/osrelease") ?? "");
}

function pipewireDropInDir(env: NodeJS.ProcessEnv): string {
	const home = env.HOME?.trim() || homedir();
	const xdgConfig = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
	return join(xdgConfig, "pipewire", "pipewire.conf.d");
}

export function wslBridgeConfigPath(env: NodeJS.ProcessEnv): string {
	return join(pipewireDropInDir(env), BRIDGE_FILE);
}

/** Any user drop-in that already points at the WSLg server counts, including manual setups. */
function hasBridge(env: NodeJS.ProcessEnv, io: WslAudioIo): boolean {
	const dir = pipewireDropInDir(env);
	return io.listDir(dir)
		.filter((name) => name.endsWith(".conf"))
		.some((name) => (io.readText(join(dir, name)) ?? "").includes(WSLG_PULSE_SERVER));
}

export function wslTunnelConfig(): string {
	return [
		"# Written by Gentle Voice. Bridges the WSLg PulseAudio server into PipeWire",
		"# so pw-record and pw-play reach the Windows microphone and speakers.",
		"# nofail: if WSLg is down, PipeWire still starts (without the tunnel).",
		"context.modules = [",
		"  { name = libpipewire-module-pulse-tunnel",
		"    flags = [ nofail ]",
		"    args = {",
		"      tunnel.mode = source",
		`      pulse.server.address = "unix:${WSLG_PULSE_SERVER}"`,
		'      target.object = "RDPSource"',
		'      node.name = "wslg-mic"',
		'      node.description = "WSLg Microphone"',
		"      audio.rate = 44100",
		"      audio.channels = 1",
		"    }",
		"  }",
		"  { name = libpipewire-module-pulse-tunnel",
		"    flags = [ nofail ]",
		"    args = {",
		"      tunnel.mode = sink",
		`      pulse.server.address = "unix:${WSLG_PULSE_SERVER}"`,
		'      target.object = "RDPSink"',
		'      node.name = "wslg-speaker"',
		'      node.description = "WSLg Speaker"',
		"      audio.rate = 44100",
		"      audio.channels = 2",
		"    }",
		"  }",
		"]",
		"",
	].join("\n");
}

export async function planWslAudioBridge(env: NodeJS.ProcessEnv, io: WslAudioIo): Promise<WslAudioPlan> {
	if (!isWsl(env, io)) return { kind: "not-wsl" };
	if (!io.exists(WSLG_PULSE_SERVER)) return { kind: "no-wslg" };
	if (REQUIRED_BINARIES.some((bin) => !io.exists(bin))) {
		return { kind: "packages-missing", command: WSL_APT_COMMAND };
	}
	// A live source wins, wherever its tunnel is configured. Ask PipeWire first:
	// WSLg's server can hang new pactl clients while an open tunnel keeps working.
	const graph = await io.run("wpctl", ["status"], { timeoutMs: WSL_PACTL_TIMEOUT_MS });
	if (graph.ok && hasAudioSource(graph.stdout)) return { kind: "ready" };
	const sources = await io.run("pactl", ["list", "short", "sources"], { timeoutMs: WSL_PACTL_TIMEOUT_MS });
	if (!sources.ok) return { kind: "wslg-unresponsive" };
	if (!/\bRDPSource\b/.test(sources.stdout)) return { kind: "no-mic-source" };
	return hasBridge(env, io)
		? { kind: "bridge-inactive" }
		: { kind: "bridge-missing", configPath: wslBridgeConfigPath(env) };
}

/** True when the Audio section of `wpctl status` lists at least one source node. */
function hasAudioSource(status: string): boolean {
	const lines = status.split("\n");
	const start = lines.findIndex((line) => line.includes("Sources:"));
	if (start < 0) return false;
	for (const line of lines.slice(start + 1)) {
		if (/[├└]─/.test(line)) break;
		if (/\b\d+\.\s/.test(line)) return true;
	}
	return false;
}

function manualBridgeSteps(configPath: string): string {
	return [
		`1. Write the PipeWire drop-in ${configPath} (pulse-tunnel to RDPSource/RDPSink).`,
		`2. Run: ${WSL_SYSTEMCTL_ENABLE.join(" ")}`,
		`3. Run: ${WSL_SYSTEMCTL_RESTART.join(" ")}`,
		"Then run /gentle:voice setup again.",
	].join("\n");
}

async function restartInactiveBridge(host: WslAudioHost, io: WslAudioIo): Promise<WslAudioPlan> {
	const restart = WSL_SYSTEMCTL_RESTART.join(" ");
	const hint = `PipeWire has no WSLg microphone. The bridge is configured but not loaded, usually because WSLg was down when PipeWire started. Run: ${restart}`;
	if (!host.confirm || !(await host.confirm("Reconnect the WSLg microphone", `${hint}\nGentle Voice can run it now, for your user only.`))) {
		host.notify(hint, "warning");
		return { kind: "bridge-inactive" };
	}
	// enable too: a first attempt may have written the drop-in and then failed to enable.
	for (const command of [WSL_SYSTEMCTL_ENABLE, WSL_SYSTEMCTL_RESTART]) {
		const [cmd, ...args] = command;
		const result = await io.run(cmd!, args);
		if (!result.ok) {
			const reason = (result.stderr ?? "").trim() || "systemctl failed";
			host.notify(`\`${command.join(" ")}\` failed (${reason}).`, "warning");
			return { kind: "services-failed", reason };
		}
	}
	host.notify("PipeWire restarted. The WSLg bridge is loaded again.", "info");
	return { kind: "ready" };
}

/**
 * Guided WSL fix. Silent on native Linux and when the bridge already exists.
 * Writes only after confirm; never runs sudo or apt.
 */
export async function driveWslAudioBridge(
	host: WslAudioHost,
	env: NodeJS.ProcessEnv = process.env,
	io: WslAudioIo = createNodeWslAudioIo(env),
): Promise<WslAudioPlan> {
	const plan = await planWslAudioBridge(env, io);
	switch (plan.kind) {
		case "not-wsl":
		case "ready":
			return plan;
		case "no-wslg":
			host.notify(
				"WSL detected, but WSLg is not available (no /mnt/wslg/PulseServer). The microphone needs WSLg: run `wsl --update` in Windows, then `wsl --shutdown`.",
				"warning",
			);
			return plan;
		case "packages-missing":
			host.notify(
				`WSL detected. Microphone capture needs PipeWire. Run:\n${plan.command}\nThen run /gentle:voice setup again.`,
				"warning",
			);
			return plan;
		case "wslg-unresponsive":
			host.notify(
				"WSL detected, but the WSLg audio server is not responding (`pactl list short sources` failed or timed out). Run `wsl --shutdown` in Windows, reopen WSL, then /gentle:voice setup again.",
				"warning",
			);
			return plan;
		case "no-mic-source":
			host.notify(
				"WSL detected, but WSLg exposes no RDPSource microphone. In Windows, open Settings → Privacy & security → Microphone and allow desktop apps to use it. Then run `wsl --shutdown` and reopen WSL.",
				"warning",
			);
			return plan;
		case "bridge-inactive":
			return await restartInactiveBridge(host, io);
		case "bridge-missing":
			break;
		case "services-failed":
			return plan;
	}
	const steps = manualBridgeSteps(plan.configPath);
	if (!host.confirm) {
		host.notify(`WSL detected. PipeWire is not connected to the WSLg microphone.\n${steps}`, "warning");
		return plan;
	}
	const accepted = await host.confirm(
		"Connect the WSLg microphone",
		[
			"PipeWire is not connected to the Windows microphone that WSLg exposes.",
			"Gentle Voice will, for your user only:",
			steps.split("\n").slice(0, 3).join("\n"),
			"No sudo and no system files.",
		].join("\n"),
	);
	if (!accepted) {
		host.notify(`WSL microphone bridge skipped. To set it up yourself:\n${steps}`, "warning");
		return plan;
	}
	await io.writeText(plan.configPath, wslTunnelConfig());
	for (const command of [WSL_SYSTEMCTL_ENABLE, WSL_SYSTEMCTL_RESTART]) {
		const [cmd, ...args] = command;
		const result = await io.run(cmd!, args);
		if (!result.ok) {
			const reason = (result.stderr ?? "").trim() || "systemctl failed";
			host.notify(
				`Wrote ${plan.configPath}, but \`${command.join(" ")}\` failed (${reason}). WSL needs systemd: set systemd=true under [boot] in /etc/wsl.conf, run \`wsl --shutdown\`, then /gentle:voice setup again.`,
				"warning",
			);
			return { kind: "services-failed", reason };
		}
	}
	host.notify("WSLg Microphone and WSLg Speaker are connected to PipeWire.", "info");
	return { kind: "ready" };
}
