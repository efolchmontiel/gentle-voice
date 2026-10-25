import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveVibeVoiceHome } from "../lib/adapters/vibevoice-tts.ts";
import { runFirstRunPreparation } from "../lib/runtime/first-run.ts";
import { readTtsEnginePreference, resolveVoiceHomeForTts } from "../lib/vibevoice/tts-preference.ts";
import {
	classifyVibeVoiceCompatibility,
	envPreferringPersistentHome,
	ENGINE_PIPER,
	ENGINE_SKIP,
	ENGINE_VIBEVOICE,
	explainTtsBlock,
	explainVibeVoiceSetup,
	followEngineSelection,
	formatSpeechRecognitionPrompt,
	formatTemporaryLocationPrompt,
	recommendTts,
	NOT_SUPPORTED_LABEL,
	RECOMMENDED_FOR_SYSTEM,
	vibevoiceInstallState,
	type EngineInstallState,
	type VibeVoiceCompatibility,
} from "../lib/runtime/onboarding-choice.ts";

test("an explicit home override is copied away without editing the original env", () => {
	const env = {
		GENTLE_VOICE_HOME: "/tmp/gv-vibevoice-clean",
		GENTLE_VOICE_VIBEVOICE_HOME: "/tmp/gv-vibevoice-clean/vibevoice",
		XDG_DATA_HOME: "/home/example/.local/share",
	};
	const next = envPreferringPersistentHome(env);
	assert.equal(env.GENTLE_VOICE_HOME, "/tmp/gv-vibevoice-clean");
	assert.equal(next.GENTLE_VOICE_HOME, undefined);
	assert.equal(next.GENTLE_VOICE_VIBEVOICE_HOME, undefined);
	assert.equal(next.XDG_DATA_HOME, "/home/example/.local/share");
	const cleared = envPreferringPersistentHome(env, true);
	assert.equal(cleared.XDG_DATA_HOME, undefined);
});

const location = "/home/example/.local/share/gentle-voice/vibevoice";
const consentBody = "Research-oriented weights. Microsoft conditions apply.";

function hardware(over: Record<string, unknown> = {}) {
	return {
		nvidiaPresent: true,
		probe: "ok" as const,
		vramTotalMb: 8192,
		freeDiskMb: 20_000,
		diskKnown: true,
		...over,
	};
}

function recommendation(over: {
	preference?: "unset" | "piper" | "vibevoice";
	recommendationDeclined?: boolean;
	compatibility?: VibeVoiceCompatibility;
	compatibilityReasons?: readonly string[];
	installState?: EngineInstallState;
	installBlocked?: boolean;
	blockReasons?: readonly string[];
	piperRunnable?: boolean;
} = {}) {
	return recommendTts({
		preference: over.preference ?? "unset",
		recommendationDeclined: over.recommendationDeclined ?? false,
		compatibility: over.compatibility ?? "supported",
		compatibilityReasons: over.compatibilityReasons ?? [],
		piperRunnable: over.piperRunnable ?? true,
		installState: over.installState ?? "missing",
		installBlocked: over.installBlocked ?? false,
		blockReasons: over.blockReasons ?? [],
		location,
		consentBody,
	});
}

test("the selector names engines, and Pi highlights the recommended one first", () => {
	const supported = recommendation();
	assert.deepEqual(supported.options, [
		`${ENGINE_VIBEVOICE}  ${RECOMMENDED_FOR_SYSTEM}`,
		ENGINE_PIPER,
		ENGINE_SKIP,
	]);
	assert.equal(supported.options[0]?.includes("Install"), false);
	assert.equal(supported.options[0]?.includes("Finish"), false);
	const unsupported = recommendation({
		compatibility: "unsupported",
		compatibilityReasons: ["gpu_required"],
	});
	assert.equal(unsupported.options[0], `${ENGINE_PIPER}  ${RECOMMENDED_FOR_SYSTEM}`);
	assert.equal(unsupported.options[1], `${ENGINE_VIBEVOICE}  (Not supported)`);
	assert.equal(unsupported.options[2], ENGINE_SKIP);
	const unknown = recommendation({
		compatibility: "unknown",
		compatibilityReasons: ["gpu_probe_unavailable"],
	});
	assert.equal(unknown.options[0], `${ENGINE_PIPER}  ${RECOMMENDED_FOR_SYSTEM}`);
	assert.equal(unknown.options[1], `${ENGINE_VIBEVOICE}  (Compatibility unknown)`);
	assert.match(explainTtsBlock(["gpu_required"]), /NVIDIA GPU/);
	assert.match(explainTtsBlock(["gpu_probe_unavailable"]), /could not be confirmed/);
});

test("a partial install does not change the recommendation label", () => {
	const missing = recommendation({ installState: "missing" });
	const partial = recommendation({ installState: "incomplete" });
	assert.deepEqual(missing.options, partial.options);
	assert.equal(missing.recommended, "vibevoice");
});

test("hardware class is independent of files that are already on disk", () => {
	const gpu = classifyVibeVoiceCompatibility({
		os: "linux",
		arch: "x64",
		hardware: hardware(),
		python3Available: true,
	});
	assert.equal(gpu.compatibility, "supported");
	const lowVram = classifyVibeVoiceCompatibility({
		os: "linux",
		arch: "x64",
		hardware: hardware({ vramTotalMb: 6_000 }),
	});
	assert.equal(lowVram.compatibility, "supported");
	const tightDisk = classifyVibeVoiceCompatibility({
		os: "linux",
		arch: "x64",
		hardware: hardware({ freeDiskMb: 13_000 }),
	});
	assert.equal(tightDisk.compatibility, "supported");
	const noGpu = classifyVibeVoiceCompatibility({
		os: "linux",
		arch: "x64",
		hardware: hardware({ nvidiaPresent: false, probe: "no_gpu", vramTotalMb: undefined }),
	});
	assert.equal(noGpu.compatibility, "unsupported");
	const probeFailed = classifyVibeVoiceCompatibility({
		os: "linux",
		arch: "x64",
		hardware: hardware({ nvidiaPresent: false, probe: "unavailable", vramTotalMb: undefined }),
	});
	assert.equal(probeFailed.compatibility, "unknown");
	const windows = classifyVibeVoiceCompatibility({
		os: "win32",
		arch: "x64",
		hardware: hardware(),
	});
	assert.equal(windows.compatibility, "unsupported");
	assert.equal(windows.reasons.includes("platform_unvalidated"), true);
	const noPython = classifyVibeVoiceCompatibility({
		os: "linux",
		arch: "x64",
		hardware: hardware(),
		python3Available: false,
	});
	assert.equal(noPython.compatibility, "unsupported");
	const sameFilesDoNotMatter = vibevoiceInstallState({
		ready: false,
		reason: "awaiting_user_authorization",
		weightsPresent: true,
	});
	assert.equal(sameFilesDoNotMatter, "incomplete");
	assert.equal(gpu.compatibility, "supported");
});

test("the engine choice is followed by install, finish, repair, or activate", () => {
	const shared = {
		compatibility: "supported" as const,
		compatibilityReasons: [],
		installBlocked: false,
		blockReasons: [],
		piperPresent: false,
		location,
		consentBody,
	};
	const install = followEngineSelection({ ...shared, choice: "vibevoice", installState: "missing" });
	assert.equal(install.kind, "confirm");
	if (install.kind === "confirm") assert.equal(install.title, "Install VibeVoice?");
	const finish = followEngineSelection({ ...shared, choice: "vibevoice", installState: "incomplete" });
	assert.equal(finish.kind, "confirm");
	if (finish.kind === "confirm") {
		assert.equal(finish.title, "Finish VibeVoice installation?");
		assert.match(finish.message, /Missing files will be downloaded/);
	}
	const repair = followEngineSelection({
		...shared,
		choice: "vibevoice",
		installState: "damaged",
		damageDetail: "model_size_mismatch:1",
	});
	assert.equal(repair.kind, "confirm");
	if (repair.kind === "confirm") assert.match(repair.message, /model_size_mismatch/);
	const ready = followEngineSelection({ ...shared, choice: "vibevoice", installState: "installed" });
	assert.equal(ready.kind, "activate");
	const piper = followEngineSelection({ ...shared, choice: "piper", installState: "missing" });
	assert.equal(piper.kind, "confirm");
	if (piper.kind === "confirm") assert.equal(piper.engine, "piper");
	const blocked = followEngineSelection({
		...shared,
		choice: "vibevoice",
		compatibility: "unsupported",
		compatibilityReasons: ["gpu_required"],
		installState: "incomplete",
	});
	assert.equal(blocked.kind, "blocked");
	const skipped = followEngineSelection({ ...shared, choice: "skip", installState: "missing" });
	assert.equal(skipped.kind, "skip");
});

test("an explicit Piper choice and a declined recommendation are kept", () => {
	const piper = recommendation({ preference: "piper", installState: "incomplete" });
	assert.equal(piper.action, "keep");
	assert.equal(piper.options.length, 0);
	const skipped = recommendation({ recommendationDeclined: true, installState: "incomplete" });
	assert.equal(skipped.action, "keep");
	const saved = recommendation({ preference: "vibevoice", compatibility: "unsupported", compatibilityReasons: ["gpu_required"] });
	assert.equal(saved.action, "inform");
	assert.equal(saved.offerSwitch, true);
	assert.match(saved.message, /stays selected/);
});

test("speech recognition names the directory it was given", () => {
	const text = formatSpeechRecognitionPrompt(80 * 1024 * 1024, "/home/example/.local/share/gentle-voice");
	assert.match(text, /Whisper\.cpp/);
	assert.match(text, /\/home\/example\/\.local\/share\/gentle-voice/);
	assert.equal(text.includes("/tmp/gv-vibevoice-clean"), false);
	assert.match(explainVibeVoiceSetup("partial", "archive_member_missing:sp-Spk0_woman.pt"), /Spanish voice/);
});

test("a tmpfs override does not create that directory when the fallback is also tmpfs", async () => {
	const root = mkdtempSync(join(tmpdir(), "gv-onboard-choice-"));
	const override = join(root, "override");
	const notices: string[] = [];
	const env = {
		HOME: root,
		XDG_DATA_HOME: join(root, "xdg"),
		GENTLE_VOICE_HOME: override,
	};
	const snap = await runFirstRunPreparation({
		notify: (message) => notices.push(message),
		select: async () => {
			throw new Error("tmpfs fallback should not ask to install");
		},
	}, env, { filesystemOf: () => "tmpfs" });
	assert.equal(snap.status, "needs_manual");
	assert.match(notices.join("\n"), /tmpfs/);
	assert.equal(existsSync(override), false);
	assert.equal(env.GENTLE_VOICE_HOME, override);
});

test("XDG and an explicit home decide the engine directory", () => {
	const fallback = resolveVibeVoiceHome({ HOME: "/home/example" });
	if (process.platform === "linux") {
		const custom = resolveVibeVoiceHome({
			HOME: "/home/example",
			XDG_DATA_HOME: "/home/example/.var/share",
		});
		assert.equal(custom, "/home/example/.var/share/gentle-voice/vibevoice");
		assert.equal(fallback, "/home/example/.local/share/gentle-voice/vibevoice");
	} else if (process.platform === "darwin") {
		const home = join("/home/example", "Library", "Application Support", "gentle-voice", "vibevoice");
		assert.equal(resolveVibeVoiceHome({
			HOME: "/home/example",
			XDG_DATA_HOME: "/home/example/.var/share",
		}), home);
		assert.equal(fallback, home);
	} else {
		const home = join("/home/example", "AppData", "Local", "gentle-voice", "vibevoice");
		assert.equal(resolveVibeVoiceHome({
			HOME: "/home/example",
			XDG_DATA_HOME: "/home/example/.var/share",
		}), home);
		assert.equal(fallback, home);
	}
	const explicit = resolveVibeVoiceHome({
		HOME: "/home/example",
		GENTLE_VOICE_HOME: "/srv/voice-data",
	});
	assert.equal(explicit, join("/srv/voice-data", "vibevoice"));
	const prompt = formatTemporaryLocationPrompt("/tmp/session/gentle-voice", fallback);
	assert.match(prompt, /tmpfs/);
	assert.match(prompt, /left as you set them/);
});

test("onboarding source does not embed a personal or lab path", () => {
	const source = readFileSync(new URL("../lib/runtime/onboarding-choice.ts", import.meta.url), "utf8");
	assert.equal(source.includes("/home/erickfm"), false);
	assert.equal(source.includes("WD-Black"), false);
	assert.equal(source.includes("gs-lab"), false);
});

test("a clean home asks for an engine and downloads nothing when consent is refused", async () => {
	const parent = existsSync(join(homedir(), ".cache")) ? join(homedir(), ".cache") : homedir();
	const root = mkdtempSync(join(parent, "gv-onboard-selector-"));
	const titles: string[] = [];
	const confirms: string[] = [];
	let picked = "";
	const linux64 = process.platform === "linux" && process.arch === "x64";
	try {
		const env = {
			HOME: root,
			XDG_DATA_HOME: join(root, "share"),
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_CACHE_HOME: join(root, "cache"),
		};
		await runFirstRunPreparation({
			notify: () => undefined,
			select: async (title, options) => {
				titles.push(title);
				assert.equal(title, "Choose your voice engine");
				assert.equal(options.some((option) => option.startsWith("Finish")), false);
				assert.equal(options.some((option) => option.startsWith("Install")), false);
				assert.equal(options.some((option) => option.startsWith("Use ")), false);
				const recommended = options.filter((option) => option.includes(RECOMMENDED_FOR_SYSTEM));
				if (linux64) {
					assert.equal(recommended.length, 1);
					picked = options[0] ?? "";
					return options[0];
				}
				assert.equal(recommended.length, 0);
				assert.equal(options.some((option) => option.includes(NOT_SUPPORTED_LABEL)), true);
				return ENGINE_SKIP;
			},
			confirm: async (title) => {
				confirms.push(title);
				return false;
			},
		}, env);
		assert.deepEqual(titles, ["Choose your voice engine"]);
		assert.equal(confirms.includes("Install speech recognition?"), true);
		assert.ok(confirms.indexOf("Silero VAD") > confirms.indexOf("Install speech recognition?"));
		const askedForEngine = confirms.some((title) => title.startsWith("Install VibeVoice") || title.startsWith("Finish VibeVoice") || title === "Install Piper?");
		assert.equal(askedForEngine, linux64);
		const names = existsSync(join(root, "share"))
			? readdirSync(join(root, "share"), { recursive: true }).map(String)
			: [];
		assert.equal(names.some((name) => name.endsWith(".safetensors") || name.endsWith(".onnx")), false);
		const saved = readTtsEnginePreference(resolveVoiceHomeForTts(env));
		if (!linux64) assert.equal(saved, "unset");
		else if (picked.startsWith(ENGINE_VIBEVOICE)) assert.equal(saved, "vibevoice");
		else if (picked.startsWith(ENGINE_PIPER)) assert.equal(saved, "piper");
		else assert.equal(saved, "unset");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
