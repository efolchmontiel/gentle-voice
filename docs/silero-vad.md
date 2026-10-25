# Silero VAD — phase 3.6 increment 1

## Goal

Replace (when available) the energy-only end-of-utterance detector with **Silero ONNX**, keeping **energy VAD as fail-closed fallback**. PipeWire capture (`pw-record` → PCM s16le @ 16 kHz) is unchanged.

## Architecture

```
pw-record stdout PCM
        │
        ▼
 PipewireCaptureAdapter
        │  resolveVad(preference)
        ├─ silero (sherpa-onnx + silero_vad.onnx) ───────┐
        └─ energy (RMS) ← fallback on any Silero miss ───┤
                                                         ▼
                                              onVadEnd → finishListen
```

| Piece | Role |
| --- | --- |
| `lib/vad/types.ts` | Shared `VadEngine` contract |
| `lib/vad/energy-vad.ts` | Existing RMS VAD (fallback) |
| `lib/vad/silero-vad.ts` | 512-sample frames @ 16 kHz through the sherpa-onnx `Vad` |
| `lib/vad/sherpa-runtime.ts` | Pinned sherpa-onnx download, checks, and Gentle Shell reuse |
| `lib/vad/resolve-vad.ts` | `auto` / `silero` / `energy` selection |
| `pipewire-capture.ts` | Resolves engine per `start()` |

## Config / env

| Knob | Values | Default |
| --- | --- | --- |
| `behavior.vadBackend` | `energy` \| `silero` \| `auto` | `auto` |
| `behavior.sileroModelPath` | absolute path | unset |
| `GENTLE_VOICE_VAD` | same as vadBackend | overrides when set |
| `GENTLE_VOICE_SILERO_VAD` | path to `.onnx` | — |

Without the model **or** without the sherpa-onnx runtime, `auto` ≡ energy → **no change** to the six GS-Lab-approved behaviors.

If Silero inference fails after capture starts, the same audio stream switches to
Energy VAD, preserving speech already observed by the fallback. A low speech
probability alone does not trigger recovery. Each capture releases its ONNX
engine on close, cancellation, or process error.

## Pi onboarding

The model is not in the npm package. After TTS setup, Pi checks
`~/.local/share/gentle-voice/models/silero/silero_vad.onnx` (or the active
`GENTLE_VOICE_HOME` models directory). It also needs the sherpa-onnx runtime
(`<data>/runtime/sherpa-onnx-1.13.8-<platform>`, or the one Gentle Shell installed
under `~/.pi/gentle-ai/voice/runtime`). If either is missing, Pi shows one
consent screen that says what Silero does and lists both parts: the model pinned
to commit `1e261b036686cd0017d500ee96acd1c4ba572a9d` (2,327,524 bytes, MIT) and
the runtime (about 11 MB download and 33 MB on disk on Linux x64, Apache-2.0 with
ONNX Runtime under MIT). Both archives are checked against pinned sizes and
sha512 hashes before anything is extracted. A decline is stored in `vad.json` and Energy VAD stays
active without asking again. A correct VibeVoice install does not mark
conversation mode ready while Silero is absent.

## Lab enablement (after authorization)

1. Accept the Silero consent once, or reuse the Gentle Shell sherpa-onnx runtime.
2. Download MIT model (~1–2 MB):  
   `https://github.com/snakers4/silero-vad` → `silero_vad.onnx`  
   Store under sandbox/WD-Black private models, e.g.  
   `$GENTLE_VOICE_MODELS/silero/silero_vad.onnx`
3. Export for GS-Lab:
   ```bash
   export GENTLE_VOICE_VAD=auto
   export GENTLE_VOICE_SILERO_VAD=/path/to/silero_vad.onnx
   ```
4. Launch `./launch-voice-lab.sh` (checkout `-e`). Confirm chrome/status shows Silero when wired; otherwise energy fallback reason in diagnostics.

## Timing defaults (Silero)

Slightly tighter than energy product defaults (measurable A/B):

| | Energy (typical) | Silero defaults |
| --- | --- | --- |
| Hang after speech | 1200 ms | **900 ms** |
| Intra-pause | 450 ms | **350 ms** |
| Post-roll | 200–220 ms | **150 ms** |
| Speech gate | RMS threshold | prob ≥ **0.5** |

**Gate for keeping Silero as default:** ≥20% shorter end-of-utterance wait **without** cutting Spanish words (human + synthetic battery).

## What this increment does NOT do

- STT incremental / provisional text  
- Streaming TTS gap work  
- Barge-in against speakers  
- Chatterbox / Kokoro / Fish Speech  

## License

- Silero model: **MIT** (snakers4/silero-vad) — add NOTICE when shipping model downloads.  
- sherpa-onnx: **Apache-2.0**, bundling ONNX Runtime (**MIT**).  
- Do **not** copy BUSL po-voice Silero wrappers.
