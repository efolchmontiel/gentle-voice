/**
 * Last steps of the single onboarding assistant: Silero, microphone, summary.
 * Downloads stay behind their own consent. Installed components are not repeated.
 */

import { driveSileroInstall, type SileroDriveHost } from "../vad/silero-install.ts";
import {
	readCapabilities,
	writeCapabilities,
	type VoiceCapabilities,
} from "./capabilities.ts";

export interface ConversationSetupInput {
	readonly ttsInstalled: boolean;
	readonly ttsReady: boolean;
	readonly ttsActive: boolean;
	readonly sttReady: boolean;
	readonly playbackReady: boolean;
}

export async function completeConversationSetup(
	host: SileroDriveHost,
	env: NodeJS.ProcessEnv,
	input: ConversationSetupInput,
): Promise<VoiceCapabilities> {
	const previouslyConfigured = readCapabilities(env) !== undefined;
	if (host.prepareCapture) {
		try {
			await host.prepareCapture();
		} catch (error) {
			const message = error instanceof Error ? error.message : "capture_prepare_failed";
			host.notify(`Microphone preparation failed (${message}).`, "warning");
		}
	}
	let silero: Awaited<ReturnType<typeof driveSileroInstall>>;
	try {
		silero = await driveSileroInstall(host, { env });
	} catch (error) {
		const message = error instanceof Error ? error.message : "silero_setup_failed";
		host.notify(`Silero VAD setup failed (${message}). Energy fallback stays active.`, "warning");
		silero = { status: "missing", path: "", initialized: false };
	}
	const captureReady = host.captureReady ? await host.captureReady() : false;
	const vadChoice = silero.status === "declined"
		? "energy"
		: silero.status === "corrupt"
			? "corrupt"
			: silero.initialized
				? "silero"
				: "missing";
	const vadReady = silero.initialized === true;
	const conversationReady = input.ttsReady
		&& input.ttsActive
		&& input.sttReady
		&& vadReady
		&& captureReady
		&& input.playbackReady;
	const summary = conversationReady
		? "Components are installed. Speak once to confirm the full conversation path. This check did not prove a live reply."
		: vadChoice === "energy"
			? "Silero was declined. Hands-free conversation stays on the energy fallback and is not the recommended setup."
			: !input.sttReady
				? "Speech recognition is missing. Conversation cannot transcribe until Whisper is installed."
				: !vadReady
					? "Silero is not active. Hands-free conversation is not ready."
					: !captureReady
						? "Microphone capture is not available. Conversation cannot listen."
						: "Voice components are incomplete. Conversation is not ready.";
	const caps: VoiceCapabilities = {
		schema: "gentle-voice.capabilities/v1",
		updatedAt: new Date().toISOString(),
		ttsInstalled: input.ttsInstalled,
		ttsReady: input.ttsReady,
		ttsActive: input.ttsActive,
		sttReady: input.sttReady,
		vadReady,
		vadChoice,
		captureReady,
		playbackReady: input.playbackReady,
		conversationReady,
		summary,
	};
	await writeCapabilities(env, caps);
	host.notify(
		formatConversationSetup(caps, previouslyConfigured),
		conversationReady ? "info" : "warning",
	);
	return caps;
}

/** Keep routine starts to one line; the checklist belongs to first setup. */
export function formatConversationSetup(caps: VoiceCapabilities, previouslyConfigured: boolean): string {
	if (previouslyConfigured && caps.conversationReady) return "🎙️  Ready to talk";
	return [
		"Gentle Voice setup",
		`TTS ${caps.ttsActive ? "active" : caps.ttsInstalled ? "installed" : "missing"}`,
		`STT ${caps.sttReady ? "ready" : "missing"}`,
		`VAD ${caps.vadChoice}`,
		`Microphone ${caps.captureReady ? "ready" : "missing"}`,
		`Playback ${caps.playbackReady ? "ready" : "missing"}`,
		`Conversation ${caps.conversationReady ? "components ready" : "not ready"}`,
		caps.summary,
	].join("\n");
}
