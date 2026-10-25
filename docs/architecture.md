# Architecture (phase 1)

## Goals

- Independent pi-package for Pi Coding Agent ≥ 1.2
- Optional Gentle Shell as a compatibility harness only
- **Recommended engines:** Whisper.cpp (STT) + Piper (TTS) — validated target, not a universal supremacy claim
- Intelligent reuse of compatible engines already on disk
- Degrade when mic/engines/models are missing
- Never narrate tools, subagents, or internal chatter
- No mandatory second LLM
- No sudo / no automatic global package mutation
- Portable install roots (any disk with write permission)

## Layers

| Layer | Responsibility |
| --- | --- |
| `extensions/voice.ts` | Pi registration (`/gentle-voice`, gated shortcut, lifecycle hooks) |
| `lib/commands.ts` | Argument parsing |
| `lib/config.ts` | Schema + path resolution via env |
| `lib/engines/*` | Detection, install **plans** (simulated), hardware, models, setup |
| `lib/shortcut.ts` | `Ctrl+Alt+Space` only if verified available |
| `lib/state-machine.ts` | Pure phase/mode transitions |
| `lib/final-utterance.ts` | Deterministic speakable summary |
| `lib/voice-session.ts` | Effect runner + adapter orchestration |
| `lib/adapters/*` | Capture / STT / TTS / playback (stubs now) |
| `lib/process-cancel.ts` | Abort graphs for future child processes |

## Recommended vs alternatives

| Role | Recommended | Detectable alternatives (phase 1) |
| --- | --- | --- |
| STT | `whisper-cpp` | `vosk`, `sherpa-onnx` |
| TTS | `piper` | `espeak-ng`, `mimic3` |

Adapters remain independent so engines can be swapped later.

## First-run scenarios

| Code | Meaning |
| --- | --- |
| `A_none` | No compatible engines → offer recommended install (consent) |
| `B_both_recommended` | Whisper + Piper ready → reuse |
| `C_partial` | One recommended missing → install only the gap |
| `D_alternatives` | Compatible alternatives present → reuse or choose recommended |
| `E_incompatible` | Found but incompatible → explain; do not modify; recommend Whisper+Piper |

## Setup modes

- **recommended** — Whisper.cpp + Piper (+ default models sized by RAM; Spanish-capable)
- **reuse** — keep detected compatible engines
- **advanced** — manual engines/models/paths

## Shortcut

Preferred: `Ctrl+Alt+Space`. Register **only** after availability is verified.  
If conflict/unverifiable → stay disabled. Never auto-bind a different chord.  
`/gentle-voice` remains the universal command.

## Phase 1 boundary

Contracts, detection, mocks, unit tests. **No** real downloads, **no** real mic/TTS wiring, **no** publishing.
