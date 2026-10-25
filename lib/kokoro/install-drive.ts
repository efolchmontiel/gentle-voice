/**
 * Runs the Kokoro install with status-line progress, then activates the engine
 * in the current session. Activation does not play audio.
 */

import type { InstallDriveHost } from "../vibevoice/install-drive.ts";
import { runKokoroInstall, type KokoroInstallResult } from "./install.ts";
import { KOKORO_DEFAULT_VOICE } from "./manifest.ts";

export const KOKORO_INSTALL_STATUS_KEY = "gentle-voice-kokoro-install";

export function explainKokoroSetup(result: KokoroInstallResult): string {
	if (result.status === "cancelled") return "Installation cancelled.";
	if (result.status === "declined") return "Kokoro was not installed.";
	if (result.status === "corrupt") {
		return `A Kokoro download did not match its pinned hash and was deleted. Run /gentle-voice tts kokoro to retry.\nDetail: ${result.reason}`;
	}
	if (result.reason === "python_unsupported") {
		return "Kokoro needs Python 3.11 to 3.14 to create its private environment. Install one and run /gentle-voice tts kokoro again.";
	}
	const detail = result.detail
		? `\nDetail:\n${result.detail.trim().split(/\r?\n/).slice(-6).join("\n")}`
		: "";
	return `Kokoro setup: ${result.status}\nVerified files were kept. Run /gentle-voice tts kokoro to retry.\nReason: ${result.reason}${detail}`;
}

export async function driveKokoroInstall(
	host: InstallDriveHost,
	input: Parameters<typeof runKokoroInstall>[0],
): Promise<KokoroInstallResult> {
	host.notify("Installing Kokoro...", "info");
	host.setStatus?.(KOKORO_INSTALL_STATUS_KEY, "Installing Kokoro...");
	let result: KokoroInstallResult;
	try {
		result = await runKokoroInstall({
			...input,
			onProgress: (message) => {
				host.setStatus?.(KOKORO_INSTALL_STATUS_KEY, message);
				input.onProgress?.(message);
			},
		});
	} finally {
		host.setStatus?.(KOKORO_INSTALL_STATUS_KEY, undefined);
	}
	if (result.status !== "installed" && result.status !== "reused") {
		host.notify(explainKokoroSetup(result), "warning");
		return result;
	}
	const live = await host.activateEngine?.();
	const active = Boolean(live?.ttsId?.includes("kokoro"));
	host.notify(
		active
			? `Kokoro is ready. Voice ${KOKORO_DEFAULT_VOICE}, CPU.`
			: `Kokoro is installed, but this session is using ${live?.ttsId ?? "another engine"}. Run /gentle-voice tts kokoro.`,
		active ? "info" : "warning",
	);
	return result;
}
