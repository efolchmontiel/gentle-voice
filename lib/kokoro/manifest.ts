/**
 * Integrity pins for the Kokoro engine.
 *
 * Model and voices come from the kokoro-onnx model release. A download whose
 * size or hash differs is rejected. The Python packages are pinned by version.
 */

export const KOKORO_MODEL_RELEASE =
	"https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1";

export interface KokoroArtifact {
	readonly id: "model" | "voices";
	readonly relativePath: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly origin: string;
}

export const KOKORO_ARTIFACTS: readonly KokoroArtifact[] = [
	{
		id: "model",
		relativePath: "models/kokoro-v1.0.fp16.onnx",
		bytes: 163_527_961,
		sha256: "f3a290d384fbb27966d462905c71a46cef9e5fd00516b40df32a0b4afe77ac96",
		origin: `${KOKORO_MODEL_RELEASE}/kokoro-v1.0.fp16.onnx`,
	},
	{
		id: "voices",
		relativePath: "models/voices-v1.0.bin",
		bytes: 28_214_398,
		sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
		origin: `${KOKORO_MODEL_RELEASE}/voices-v1.0.bin`,
	},
];

/**
 * kokoro-onnx declares Python <3.14, but its dependencies publish 3.14 wheels
 * and synthesis was verified on 3.14. Pip is told to ignore that ceiling.
 */
export const KOKORO_PIP_REQUIREMENTS: readonly string[] = Object.freeze(["kokoro-onnx==0.6.1"]);

export const KOKORO_DEFAULT_VOICE = "ef_dora" as const;
export const KOKORO_SPANISH_VOICES: readonly string[] = Object.freeze(["ef_dora", "em_alex", "em_santa"]);
export const KOKORO_LANG = "es" as const;
/** English lives in the same voices-v1.0.bin, so switching costs no download. */
export const KOKORO_ENGLISH_VOICE = "af_heart" as const;
export const KOKORO_ENGLISH_LANG = "en-us" as const;

/** Model, voices, and the private venv, measured on Linux x64 with Python 3.14. */
export const KOKORO_INSTALLED_BYTES = 390_000_000;

export const KOKORO_INTEGRITY_KIND = "gentle-voice.kokoro-integrity" as const;
