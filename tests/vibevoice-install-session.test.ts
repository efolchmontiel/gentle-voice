import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	beginVibeVoiceInstall,
	cancelVibeVoiceInstall,
	commandSkipsInstallWait,
	resetVibeVoiceInstallState,
	vibeVoiceInstallSnapshot,
} from "../lib/vibevoice/install-session.ts";
import type { VibeVoiceArtifact } from "../lib/vibevoice/manifest.ts";
import { createHash } from "node:crypto";
import type { OnboardingIo } from "../lib/vibevoice/onboarding.ts";

const hardware = { nvidiaPresent: true, vramTotalMb: 8192, freeDiskMb: 20_000 };

function artifact(id: VibeVoiceArtifact["id"], relativePath: string, body: string): VibeVoiceArtifact {
	const bytes = Buffer.from(body);
	return {
		id,
		relativePath,
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		origin: `fixture://${id}`,
	};
}

function slash(value: string): string {
	return value.replace(/\\/g, "/");
}

function ioWithHeldPip(release: { go: () => void }, signalBox: { signal?: AbortSignal }): OnboardingIo {
	let depsReady = false;
	return {
		async fetch(item, destination) {
			writeFileSync(destination, item.id);
		},
		async run(command, args, signal) {
			signalBox.signal = signal;
			if (args[0] === "-c" && String(args[1]).includes("GVPY")) {
				return { code: 0, detail: "GVPY 3.14" };
			}
			if (args[0] === "-m" && args[1] === "venv") {
				const venv = args[2]!;
				mkdirSync(join(venv, "bin"), { recursive: true });
				writeFileSync(join(venv, "bin", "python"), "#!/bin/sh\nexit 0\n");
				writeFileSync(join(venv, "bin", "pip"), "#!/bin/sh\nexit 0\n");
				return { code: 0 };
			}
			if (args.some((arg) => arg.includes("importlib.metadata"))) return { code: depsReady ? 0 : 4 };
			if (slash(command).endsWith("/.venv/bin/pip") && !depsReady) {
				await new Promise<void>((resolve, reject) => {
					const finish = (): void => resolve();
					release.go = () => {
						depsReady = true;
						finish();
					};
					signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				});
				return { code: 0 };
			}
			return { code: 0 };
		},
	};
}

function layout(): { target: string; voiceHome: string; artifacts: VibeVoiceArtifact[] } {
	const root = mkdtempSync(join(tmpdir(), "gv-vv-session-"));
	const target = join(root, "engine");
	const voiceHome = join(root, "voice");
	mkdirSync(voiceHome, { recursive: true });
	return {
		target,
		voiceHome,
		artifacts: [
			artifact("weights", "models/VibeVoice-Realtime-0.5B/model.safetensors", "weights"),
			artifact("spanish-voice", "voices/sp-Spk0_woman.pt", "spanish-voice"),
			artifact("code-license", "code/LICENSE", "code-license"),
			artifact("code-project", "code/pyproject.toml", "code-project"),
		],
	};
}

test("diagnostic commands do not wait for the install", () => {
	assert.equal(commandSkipsInstallWait("status", ""), true);
	assert.equal(commandSkipsInstallWait("vibevoice-setup", "plan"), true);
	assert.equal(commandSkipsInstallWait("vibevoice-setup", "cancel"), true);
	assert.equal(commandSkipsInstallWait("vibevoice-setup", ""), false);
	assert.equal(commandSkipsInstallWait("listen", ""), false);
});

async function waitForPhase(message: string): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < 1000) {
		if (vibeVoiceInstallSnapshot().message === message) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`install stayed at ${vibeVoiceInstallSnapshot().phase}: ${vibeVoiceInstallSnapshot().message} running=${vibeVoiceInstallSnapshot().running}`);
}

test("a second start joins the install that is already running", async () => {
	resetVibeVoiceInstallState();
	const { target, voiceHome, artifacts } = layout();
	const release = { go: () => undefined };
	const first = beginVibeVoiceInstall({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: ioWithHeldPip(release, {}),
		artifacts,
	});
	const second = beginVibeVoiceInstall({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		artifacts,
	});
	assert.equal(first, second);
	await waitForPhase("Installing dependencies");
	assert.equal(vibeVoiceInstallSnapshot().running, true);
	release.go();
	const result = await first;
	assert.equal(result.status, "installed");
	assert.equal(vibeVoiceInstallSnapshot().running, false);
	resetVibeVoiceInstallState();
});

test("cancel during pip reports Installation cancelled and can start again", async () => {
	resetVibeVoiceInstallState();
	const { target, voiceHome, artifacts } = layout();
	const release = { go: () => undefined };
	const running = beginVibeVoiceInstall({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: ioWithHeldPip(release, {}),
		artifacts,
	});
	await waitForPhase("Installing dependencies");
	assert.equal(cancelVibeVoiceInstall(), true);
	const result = await running;
	assert.equal(result.status, "cancelled");
	assert.equal(vibeVoiceInstallSnapshot().message, "Installation cancelled.");
	assert.equal(vibeVoiceInstallSnapshot().running, false);
	const next = { go: () => undefined };
	const again = beginVibeVoiceInstall({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: ioWithHeldPip(next, {}),
		artifacts,
	});
	await waitForPhase("Installing dependencies");
	assert.equal(vibeVoiceInstallSnapshot().running, true);
	next.go();
	assert.equal((await again).status, "installed");
	resetVibeVoiceInstallState();
});
