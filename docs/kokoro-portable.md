# Kokoro portable TTS — design only (phase 3.4.1)

Status: **design**. No model downloads, no engine installs in this phase.

## Goal

- Default TTS: Kokoro (natural Spanish voice, e.g. ef_dora class).
- Fallback: Piper (already pinned in first-run).
- No global Python / pip / system packages.
- No developer hard-coded lab paths in the published package.
- No cloud API keys.
- Consent-gated download into host storage (`resolveGentleVoiceStorage()` root).
- Windows / Linux / macOS when demonstrated — not claimed until smoke-tested.

## Current lab reality (not product)

Lab uses a private venv + ONNX configured via `GENTLE_VOICE_LAB_ROOT` / `GENTLE_VOICE_KOKORO_*` (`lib/adapters/kokoro-tts.ts`). Gated behind `GENTLE_VOICE_LAB=1` / `GENTLE_VOICE_REAL_AUDIO=1`.

## Recommended product approach

**Native ONNX Runtime (Node binding) + Kokoro ONNX assets under private storage.**

| Piece | Candidate | Notes |
| --- | --- | --- |
| Runtime | sherpa-onnx (already downloaded for Silero, Kokoro support built in) | Avoids Python; pin exact version + platform binaries |
| Model | Kokoro ONNX quantized (~80–200 MB class; measure before pin) | SHA-256 in `artifacts.ts` |
| Voices | Single-voice NPZ/ONNX voice pack (ef_dora or successor) | License review required |
| G2P / phonemizer | Prefer pure-JS or bundled tiny asset; avoid system espeak if possible | Lab needed espeak path for Spanish — must be solved or documented |
| Synth entry | Small TS adapter `createKokoroOnnxTtsAdapter` reading paths from storage | Same `TtsAdapter` contract as Piper |

### Storage layout (per host)

```text
<storageRoot>/
  bin/           # optional ORT helpers if not npm-native
  models/kokoro/
    model.onnx
    voices/...
    vocab-config.json
  cache/
  tmp/
```

GS isolated → under `<prefix>/gentle-voice/…`. Pi → XDG / LocalAppData / Application Support.

### First-run flow

1. Piper remains always installable (current pins).
2. Optional consent step: “Download Kokoro ONNX (~N MB, license …)?”
3. On success → set default TTS to Kokoro; Piper stays fallback on failure.
4. Opt-out: `GENTLE_VOICE_DISABLE_DOWNLOADS=1` / decline consent → Piper only.

### Licenses (to confirm before ship)

- Kokoro model / voice weights — verify redistribution terms.
- ONNX Runtime — MIT.
- Any phonemizer dependency — document in `THIRD_PARTY_NOTICES.md`.

### OS matrix (future claims only after smoke)

| OS | ORT node | Capture/Playback | Claim |
| --- | --- | --- | --- |
| Linux x64 | planned | PipeWire experimental | after clean-HOME synth+play |
| Linux arm64 | planned | pending | after device run |
| Windows x64 | planned | ffmpeg WASAPI unverified | blocked until audio smoke |
| macOS arm64 | planned | CoreAudio unverified | blocked until audio smoke |

### Alternatives considered

| Option | Why not now |
| --- | --- |
| Ship Python venv in tarball | Large, fragile, still “Python” |
| Cloud TTS | Needs API keys — out of scope |
| Keep lab Python paths in product | Violates isolation |

### Implementation phases (suggested)

1. Spike: onnxruntime-node synth of fixed Spanish phrase → WAV (lab machine only).
2. Pin artifacts + SHA + size in `artifacts.ts`.
3. Adapter + first-run consent + Piper fallback.
4. Clean-HOME / GS-prefix smoke; then OS matrix.

**This phase does not download or install any of the above.**
