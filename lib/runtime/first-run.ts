/**
 * First-run readiness + consent-gated preparation (no lab env vars required).
 * Idempotent. Opt-out: GENTLE_VOICE_DISABLE_DOWNLOADS=1
 */

import { access, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { detectVoicePlatform } from "../config.ts";
import {
	artifactsFor,
	detectArch,
	formatBytes,
	totalEstimatedBytes,
	type CpuArch,
	type RuntimeArtifact,
} from "./artifacts.ts";
import { checksumMatches, sha256File } from "./checksum.ts";
import { installArtifact } from "./download.ts";
import { resolveRuntimeLayout, type GentleVoiceRuntimeLayout } from "./paths.ts";
import { probeVibeVoiceReadiness, resolveVibeVoiceHome } from "../adapters/vibevoice-tts.ts";
import {
	formatVibeVoiceConsent,
	planVibeVoiceInstall,
	probeVibeVoiceHardware,
	python3CanCreateVenv,
} from "../vibevoice/install-plan.ts";
import { createNetworkOnboardingIo } from "../vibevoice/network-io.ts";
import { formatPiperActivation, formatVibeVoiceActivation, formatWhisperActivation } from "../vibevoice/activation.ts";
import { driveVibeVoiceInstall, type InstallDriveHost } from "../vibevoice/install-drive.ts";
import { completeConversationSetup } from "./conversation-setup.ts";
import {
	readTtsEnginePreference,
	readTtsRecommendationDeclined,
	resolveVoiceHomeForTts,
	writeTtsEnginePreference,
	writeTtsRecommendationDeclined,
} from "../vibevoice/tts-preference.ts";
import {
	classifyVibeVoiceCompatibility,
	envPreferringPersistentHome,
	followEngineSelection,
	formatPiperPrompt,
	formatSpeechRecognitionPrompt,
	formatTemporaryLocationPrompt,
	KEEP_TEMPORARY_LOCATION,
	parseEngineChoice,
	recommendTts,
	SKIP_TTS,
	USE_PERSISTENT_LOCATION_PREFIX,
	vibevoiceInstallState,
	weightsLookComplete,
} from "./onboarding-choice.ts";

export type ReadinessStatus =
	| "ready"
	| "needs_consent"
	| "needs_manual"
	| "unsupported_platform"
	| "downloads_disabled"
	| "partial"
	| "error";

export interface ReadinessSnapshot {
	readonly schema: "gentle-voice.readiness/v1";
	readonly status: ReadinessStatus;
	readonly checkedAt: string;
	readonly platform: string;
	readonly arch: CpuArch | "other";
	readonly layoutHome: string;
	readonly missing: readonly string[];
	readonly present: readonly string[];
	readonly message: string;
	readonly estimatedDownloadBytes: number;
	readonly blockers: readonly string[];
}

export interface FirstRunPlan {
	readonly layout: GentleVoiceRuntimeLayout;
	readonly arch: CpuArch | "other";
	readonly missing: readonly RuntimeArtifact[];
	readonly present: readonly RuntimeArtifact[];
	readonly status: ReadinessStatus;
	readonly summary: string;
	readonly estimatedDownloadBytes: number;
	readonly blockers: readonly string[];
}

export interface FirstRunHost extends InstallDriveHost {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	confirm?(title: string, message: string): Promise<boolean>;
	select?(title: string, options: readonly string[]): Promise<string | undefined>;
	captureReady?(): Promise<boolean>;
	prepareCapture?(): Promise<void>;
}

async function finishConversation(
	host: FirstRunHost,
	env: NodeJS.ProcessEnv,
	plan: FirstRunPlan,
): Promise<void> {
	if (typeof host.confirm !== "function") return;
	const live = host.activateEngine ? await host.activateEngine() : undefined;
	const sttReady = !plan.missing.some((item) => item.kind.startsWith("stt"));
	const piperMissing = plan.missing.some((item) => item.id.startsWith("piper"));
	const vibevoiceReady = probeVibeVoiceReadiness(env).ready;
	const ttsInstalled = vibevoiceReady || !piperMissing;
	const ttsActive = Boolean(live?.ttsId && live.ttsId !== "stub");
	await completeConversationSetup(host, env, {
		ttsInstalled,
		ttsReady: ttsInstalled,
		ttsActive,
		sttReady,
		playbackReady: live !== undefined,
	});
}

async function existsReadable(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function artifactTarget(layout: GentleVoiceRuntimeLayout, art: RuntimeArtifact): string {
	if (art.archive) return join(layout.dataDir, art.archive.installBinaryAs);
	return join(layout.dataDir, art.relativePath);
}

export async function buildFirstRunPlan(
	env: NodeJS.ProcessEnv = process.env,
): Promise<FirstRunPlan> {
	const platform = detectVoicePlatform();
	const layout = resolveRuntimeLayout(env, platform);
	const arch = detectArch();
	const blockers: string[] = [];

	if (platform === "unsupported" || arch === "other") {
		return {
			layout,
			arch,
			missing: [],
			present: [],
			status: "unsupported_platform",
			summary: `Platform/arch not supported yet (${platform}/${arch}).`,
			estimatedDownloadBytes: 0,
			blockers: [`unsupported:${platform}/${arch}`],
		};
	}

	if (platform === "darwin") {
		blockers.push(
			"whisper-cli: no official macOS CLI binary in whisper.cpp b5454 — STT auto-install incomplete on macOS until a pinned binary is added.",
		);
	}

	const catalog = artifactsFor(platform, arch);
	const present: RuntimeArtifact[] = [];
	const missing: RuntimeArtifact[] = [];
	for (const art of catalog) {
		const path = artifactTarget(layout, art);
		if (await existsReadable(path)) present.push(art);
		else missing.push(art);
	}
	// Piper is the other engine. A chosen VibeVoice install must not look unfinished
	// just because Daniela was never downloaded.
	const preference = readTtsEnginePreference(resolveVoiceHomeForTts(env));
	const outstanding = preference === "vibevoice" && probeVibeVoiceReadiness(env).ready
		? missing.filter((art) => !art.kind.startsWith("tts"))
		: missing;

	if (outstanding.length === 0 && blockers.length === 0) {
		return {
			layout,
			arch,
			missing: outstanding,
			present,
			status: "ready",
			summary: missing.length === 0
				? "All pinned STT/TTS artifacts present under the private Gentle Voice data dir."
				: "Speech recognition is ready. The voice engine is VibeVoice.",
			estimatedDownloadBytes: 0,
			blockers,
		};
	}

	if (outstanding.length === 0 && blockers.length > 0) {
		return {
			layout,
			arch,
			missing: outstanding,
			present,
			status: "partial",
			summary: `Binaries/models present, but platform blockers remain: ${blockers.join(" ")}`,
			estimatedDownloadBytes: 0,
			blockers,
		};
	}

	if (env.GENTLE_VOICE_DISABLE_DOWNLOADS === "1") {
		return {
			layout,
			arch,
			missing: outstanding,
			present,
			status: "downloads_disabled",
			summary:
				`Missing ${outstanding.length} artifact(s) (~${formatBytes(totalEstimatedBytes(outstanding))}). `
				+ "Downloads disabled via GENTLE_VOICE_DISABLE_DOWNLOADS=1.",
			estimatedDownloadBytes: totalEstimatedBytes(outstanding),
			blockers,
		};
	}

	return {
		layout,
		arch,
		missing: outstanding,
		present,
		status: "needs_consent",
		summary:
			`Ready to download ${outstanding.length} artifact(s) (~${formatBytes(totalEstimatedBytes(outstanding))}) `
			+ "into the private Gentle Voice data directory after consent.",
		estimatedDownloadBytes: totalEstimatedBytes(outstanding),
		blockers,
	};
}

export async function loadReadiness(
	layout: GentleVoiceRuntimeLayout,
): Promise<ReadinessSnapshot | undefined> {
	try {
		const raw = await readFile(layout.readinessFile, "utf8");
		return JSON.parse(raw) as ReadinessSnapshot;
	} catch {
		return undefined;
	}
}

export async function saveReadiness(
	snapshot: ReadinessSnapshot,
	layout: GentleVoiceRuntimeLayout,
): Promise<void> {
	await mkdir(dirname(layout.readinessFile), { recursive: true });
	const tmp = `${layout.readinessFile}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
	await rename(tmp, layout.readinessFile);
}

export function snapshotFromPlan(plan: FirstRunPlan): ReadinessSnapshot {
	return {
		schema: "gentle-voice.readiness/v1",
		status: plan.status,
		checkedAt: new Date().toISOString(),
		platform: plan.layout.platform,
		arch: plan.arch,
		layoutHome: plan.layout.home,
		missing: plan.missing.map((a) => a.id),
		present: plan.present.map((a) => a.id),
		message: plan.summary,
		estimatedDownloadBytes: plan.estimatedDownloadBytes,
		blockers: plan.blockers,
	};
}

async function ensureDirs(layout: GentleVoiceRuntimeLayout): Promise<void> {
	await mkdir(layout.dataDir, { recursive: true });
	await mkdir(layout.configDir, { recursive: true });
	await mkdir(layout.modelsDir, { recursive: true });
	await mkdir(layout.binDir, { recursive: true });
	await mkdir(layout.cacheDir, { recursive: true });
	await mkdir(layout.tmpDir, { recursive: true });
	await mkdir(layout.logsDir, { recursive: true });
	await mkdir(join(layout.cacheDir, "downloads"), { recursive: true });
}

async function chooseOption(
	host: FirstRunHost,
	title: string,
	message: string,
	options: readonly string[],
): Promise<string | undefined> {
	if (typeof host.select === "function") {
		host.notify(message, "info");
		return host.select(title, options);
	}
	if (typeof host.confirm !== "function") return undefined;
	for (const option of options) {
		if (option === SKIP_TTS) continue;
		if (await host.confirm(title, `${message}\n\n${option}?`)) return option;
	}
	return SKIP_TTS;
}

function filesystemKind(directory: string): string | undefined {
	return probeVibeVoiceHardware(directory).filesystem;
}

export interface FirstRunPreparationOptions {
	/** Test seam. Production reads `findmnt`. */
	readonly filesystemOf?: (directory: string) => string | undefined;
}

async function chooseInstallEnv(
	host: FirstRunHost,
	env: NodeJS.ProcessEnv,
	readFilesystem: (directory: string) => string | undefined,
): Promise<{ env: NodeJS.ProcessEnv; refuseDownloads: boolean }> {
	const current = resolveRuntimeLayout(env).dataDir;
	const currentFs = readFilesystem(current);
	if (currentFs !== "tmpfs") return { env, refuseDownloads: false };
	let persistentEnv = envPreferringPersistentHome(env, false);
	let persistent = resolveRuntimeLayout(persistentEnv).dataDir;
	if (readFilesystem(persistent) === "tmpfs") {
		persistentEnv = envPreferringPersistentHome(env, true);
		persistent = resolveRuntimeLayout(persistentEnv).dataDir;
	}
	const prompt = formatTemporaryLocationPrompt(current, persistent);
	if (readFilesystem(persistent) === "tmpfs") {
		host.notify(`${prompt}\nThe persistent default is also on tmpfs. No speech download will start.`, "warning");
		return { env, refuseDownloads: true };
	}
	const choice = await chooseOption(host, "Install location", prompt, [
		`${USE_PERSISTENT_LOCATION_PREFIX}${persistent}`,
		KEEP_TEMPORARY_LOCATION,
	]);
	if (choice === KEEP_TEMPORARY_LOCATION) {
		const allowed = typeof host.confirm === "function"
			? await host.confirm(
				"Temporary location",
				"This path is on tmpfs. Files here can disappear. Continue only for a throwaway test?",
			)
			: false;
		if (!allowed) return { env: persistentEnv, refuseDownloads: false };
		return { env: { ...env, GENTLE_VOICE_VIBEVOICE_ALLOW_TMPFS: "1" }, refuseDownloads: false };
	}
	return { env: persistentEnv, refuseDownloads: false };
}

async function chooseSetupDownloads(
	host: FirstRunHost,
	env: NodeJS.ProcessEnv,
	plan: FirstRunPlan,
): Promise<readonly RuntimeArtifact[] | undefined> {
	if (
		typeof host.confirm !== "function"
		&& typeof host.select !== "function"
		&& env.GENTLE_VOICE_AUTO_DOWNLOAD !== "1"
	) {
		const snap = snapshotFromPlan({
			...plan,
			status: "needs_manual",
			summary: "Host has no confirm() UI. Re-run /gentle:voice setup in an interactive session.",
		});
		await saveReadiness(snap, plan.layout);
		host.notify(snap.message, "warning");
		return undefined;
	}
	const auto = env.GENTLE_VOICE_AUTO_DOWNLOAD === "1";
	const stt = plan.missing.filter((item) => item.kind.startsWith("stt"));
	const piper = plan.missing.filter((item) => item.kind.startsWith("tts"));
	const voiceHome = resolveVoiceHomeForTts(env);
	const preference = readTtsEnginePreference(voiceHome);
	const engineHome = resolveVibeVoiceHome(env);
	const readiness = probeVibeVoiceReadiness(env);
	const hardware = probeVibeVoiceHardware(engineHome);
	const vibevoicePlan = planVibeVoiceInstall({
		targetDir: engineHome,
		hardware,
		alreadyInstalled: readiness.ready,
		allowTmpfs: env.GENTLE_VOICE_VIBEVOICE_ALLOW_TMPFS === "1",
	});
	const classified = classifyVibeVoiceCompatibility({
		os: plan.layout.platform,
		arch: plan.arch,
		hardware,
		python3Available: python3CanCreateVenv(),
	});
	const installState = vibevoiceInstallState({
		ready: readiness.ready,
		reason: readiness.reason,
		weightsPresent: weightsLookComplete(engineHome),
	});
	const consentBody = formatVibeVoiceConsent(vibevoicePlan);
	const piperBody = formatPiperPrompt(totalEstimatedBytes(piper), plan.layout.dataDir);
	const recommendation = recommendTts({
		preference,
		recommendationDeclined: readTtsRecommendationDeclined(voiceHome),
		compatibility: classified.compatibility,
		compatibilityReasons: classified.reasons,
		piperRunnable: plan.layout.platform === "linux" && plan.arch === "x64",
		installState,
		installBlocked: vibevoicePlan.status === "blocked",
		blockReasons: vibevoicePlan.reasons,
		location: engineHome,
		consentBody,
		...(readiness.reason ? { damageDetail: readiness.reason } : {}),
	});
	const chosen: RuntimeArtifact[] = [];
	const acceptPiperDownload = async (): Promise<boolean> => {
		if (piper.length === 0) return true;
		if (auto) return false;
		if (typeof host.confirm !== "function") return false;
		return host.confirm("Install Piper?", piperBody);
	};
	const rememberEngine = (engine: "vibevoice" | "piper"): void => {
		writeTtsEnginePreference(voiceHome, engine);
	};
	const runVibeVoiceDownload = async (): Promise<void> => {
		await driveVibeVoiceInstall(host, {
			targetDir: engineHome,
			voiceHome,
			hardware,
			alreadyInstalled: readiness.ready,
			consent: true,
			allowNetwork: env.GENTLE_VOICE_VIBEVOICE_ALLOW_NETWORK !== "0",
			allowTmpfs: env.GENTLE_VOICE_VIBEVOICE_ALLOW_TMPFS === "1",
			io: createNetworkOnboardingIo(),
		});
	};
	const switchToPiper = async (): Promise<void> => {
		const change = typeof host.confirm === "function"
			? await host.confirm(
				"Use Piper instead?",
				"This changes the saved voice engine. Nothing downloads until you accept.",
			)
			: false;
		if (!change) return;
		rememberEngine("piper");
		if (await acceptPiperDownload()) chosen.push(...piper);
	};
	if (recommendation.action === "ask" && !auto) {
		const picked = parseEngineChoice(
			await chooseOption(host, recommendation.title, recommendation.message, recommendation.options),
		);
		if (picked === "vibevoice" || picked === "piper") {
			const follow = followEngineSelection({
				choice: picked,
				compatibility: classified.compatibility,
				compatibilityReasons: classified.reasons,
				installBlocked: vibevoicePlan.status === "blocked",
				blockReasons: vibevoicePlan.reasons,
				installState,
				piperPresent: piper.length === 0,
				location: engineHome,
				consentBody: picked === "piper" ? piperBody : consentBody,
				...(readiness.reason ? { damageDetail: readiness.reason } : {}),
			});
			if (follow.kind === "blocked") host.notify(follow.message, "warning");
			else if (follow.kind === "activate") {
				rememberEngine(follow.engine);
				if (host.activateEngine && follow.engine === "piper") {
					const live = await host.activateEngine();
					const active = live.ttsId === "piper";
					host.notify(formatPiperActivation({ voice: "es_AR-daniela-high", active }), active ? "info" : "warning");
				} else if (host.activateEngine && follow.engine === "vibevoice") {
					const live = await host.activateEngine();
					const active = Boolean(live.ttsId?.includes("vibevoice"));
					host.notify(formatVibeVoiceActivation({
						voice: "sp-Spk0_woman",
						playback: active && live.pcmSupported ? "PCM" : "WAV",
						active,
						...(!active && live.ttsId ? { detail: `active engine: ${live.ttsId}` } : {}),
					}), active ? "info" : "warning");
				} else host.notify(follow.notice, "info");
			} else if (follow.kind === "confirm") {
				rememberEngine(follow.engine);
				const accepted = typeof host.confirm === "function" && await host.confirm(follow.title, follow.message);
				if (!accepted) host.notify("Nothing was downloaded.", "info");
				else if (follow.engine === "vibevoice") await runVibeVoiceDownload();
				else chosen.push(...piper);
			}
		} else if (preference !== "vibevoice") writeTtsRecommendationDeclined(voiceHome);
	} else if (recommendation.action === "repair" && !auto) {
		host.notify(recommendation.message, "info");
		const accepted = typeof host.confirm === "function"
			&& recommendation.confirmTitle
			&& recommendation.confirmMessage
			? await host.confirm(recommendation.confirmTitle, recommendation.confirmMessage)
			: false;
		if (accepted) await runVibeVoiceDownload();
		else if (recommendation.offerSwitch) await switchToPiper();
		else host.notify("Nothing was downloaded.", "info");
	} else if (recommendation.action === "inform") {
		host.notify(recommendation.message, "warning");
		if (recommendation.offerSwitch && !auto) await switchToPiper();
	} else if (recommendation.action === "ready" && preference !== "vibevoice") {
		writeTtsEnginePreference(voiceHome, "vibevoice");
		host.notify(recommendation.message, "info");
	} else if (recommendation.action === "keep" && preference === "piper" && piper.length > 0 && !auto) {
		host.notify(recommendation.message, "info");
		if (await acceptPiperDownload()) chosen.push(...piper);
	}
	if (stt.length > 0) {
		const ok = auto || (typeof host.confirm === "function" && await host.confirm(
			"Install speech recognition?",
			formatSpeechRecognitionPrompt(totalEstimatedBytes(stt), plan.layout.dataDir),
		));
		if (ok) chosen.push(...stt);
	}
	if (chosen.length === 0 && stt.length > 0 && recommendation.action !== "ready" && recommendation.action !== "keep") {
		const snap = snapshotFromPlan({
			...plan,
			status: "needs_manual",
			summary: "No speech components were installed. Re-run /gentle:voice setup when you want them.",
		});
		await saveReadiness(snap, plan.layout);
		host.notify(snap.message, "warning");
		return undefined;
	}
	return chosen;
}

async function announceRuntimeArtifacts(
	host: FirstRunHost,
	chosen: readonly RuntimeArtifact[],
): Promise<void> {
	if (!host.activateEngine) return;
	const live = await host.activateEngine();
	if (chosen.some((artifact) => artifact.id.startsWith("piper"))) {
		const active = live.ttsId === "piper";
		host.notify(
			formatPiperActivation({ voice: "es_AR-daniela-high", active }),
			active ? "info" : "warning",
		);
	}
	if (chosen.some((artifact) => artifact.id.startsWith("whisper"))) {
		const active = live.sttKind === "whisper";
		host.notify(formatWhisperActivation(active), active ? "info" : "warning");
	}
}

/**
 * Ensure private dirs exist; evaluate readiness; download after consent.
 */
export async function runFirstRunPreparation(
	host: FirstRunHost,
	env: NodeJS.ProcessEnv = process.env,
	options: FirstRunPreparationOptions = {},
): Promise<ReadinessSnapshot> {
	const decision = await chooseInstallEnv(host, env, options.filesystemOf ?? filesystemKind);
	if (decision.refuseDownloads) {
		host.notify("The install location is on tmpfs. No speech download was started.", "warning");
		const blocked = await buildFirstRunPlan(envPreferringPersistentHome(env, true));
		return snapshotFromPlan({
			...blocked,
			status: "needs_manual",
			summary: "The install location is on tmpfs. No speech download was started.",
		});
	}
	const plan = await buildFirstRunPlan(decision.env);
	await ensureDirs(plan.layout);

	if (plan.status === "ready" || plan.status === "partial") {
		const snap = snapshotFromPlan(plan);
		await saveReadiness(snap, plan.layout);
		if (plan.status === "partial") host.notify(plan.summary, "warning");
		if (decision.env.GENTLE_VOICE_DISABLE_DOWNLOADS !== "1") {
			const extra = await chooseSetupDownloads(host, decision.env, plan);
			if (extra && extra.length > 0) {
				try {
					for (const art of extra) {
						await installArtifact(art, plan.layout, (msg) => host.notify(msg, "info"));
					}
					await announceRuntimeArtifacts(host, extra);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					host.notify(`Download/install failed: ${message}`, "error");
				}
				const after = await buildFirstRunPlan(decision.env);
				const updated = snapshotFromPlan(after);
				await saveReadiness(updated, plan.layout);
				await finishConversation(host, decision.env, after);
				return updated;
			}
			await finishConversation(host, decision.env, plan);
		}
		return snap;
	}

	host.notify(
		plan.status === "unsupported_platform"
			? plan.summary
			: "Speech recognition and the voice engine are separate. Nothing downloads until you accept.",
		plan.status === "unsupported_platform" ? "warning" : "info",
	);

	if (plan.status !== "needs_consent") {
		const snap = snapshotFromPlan(plan);
		await saveReadiness(snap, plan.layout);
		return snap;
	}

	const chosen = await chooseSetupDownloads(host, decision.env, plan);
	if (chosen === undefined) {
		await finishConversation(host, decision.env, plan);
		return (await loadReadiness(plan.layout)) ?? snapshotFromPlan(plan);
	}

	try {
		for (const art of chosen) {
			await installArtifact(art, plan.layout, (msg) => host.notify(msg, "info"));
		}
		await announceRuntimeArtifacts(host, chosen);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const snap = snapshotFromPlan({
			...plan,
			status: "error",
			summary: `Download/install failed: ${message}`,
		});
		await saveReadiness(snap, plan.layout);
		host.notify(snap.message, "error");
		return snap;
	}

	const after = await buildFirstRunPlan(decision.env);
	const snap = snapshotFromPlan(after);
	await saveReadiness(snap, plan.layout);
	const vibevoiceIsEngine = readTtsEnginePreference(resolveVoiceHomeForTts(decision.env)) === "vibevoice"
		&& probeVibeVoiceReadiness(decision.env).ready;
	if (!(snap.status === "ready" && vibevoiceIsEngine)) {
		host.notify(snap.message, snap.status === "ready" || snap.status === "partial" ? "info" : "warning");
	}
	await finishConversation(host, decision.env, after);
	return snap;
}

/** Verify a file against expected sha256. */
export async function verifyArtifactFile(
	path: string,
	expectedSha256: string,
): Promise<boolean> {
	if (!expectedSha256) return false;
	const actual = await sha256File(path);
	return checksumMatches(actual, expectedSha256);
}
