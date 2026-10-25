# Phase 3.6 — conversational UX audit (pre-implementation)

**Base branch:** `feat/phase-3.6-conversation-ux` ← `fix/phase-3.5-conversation-uninstall` (PR #5 still open; **not** from `main`).  
**Scope of this document:** audit + baseline latency only. No new engines shipped yet.

## 1. Comparative survey (npm pack → `/tmp`, not installed on user Pi)

| Package | Ver | License | STT | VAD | Partials | Barge-in / interrupt | TTS / narration |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@juicesharp/rpiv-voice` | 2.13.9 | **MIT** | sherpa-onnx Whisper base multilingual int8 (~157 MB settled) | Silero first, energy fallback | Rolling partial overlay (~live re-decode); final commits to editor | Space gates STT not mic; Esc discards | Dictation-focused (not full agent conversation) |
| `@agimon-ai/po-voice` | 0.0.0-α.29 | **BUSL-1.1** | Host/client capture pipeline | Bundled Silero ONNX (MIT model) | Client activity + endpoint silence | Ranked barge-in; echo discriminator; fail-closed | Narration + compose (`po send`/`cancel`) — **do not copy under BUSL without review** |
| `@agimon-ai/doompi-voice` | 0.0.1-α.129 | **MIT** | Similar family to po-voice | Silero / energy framing @ 16 kHz | Composition segments | Barge-in aware VAD | Narration skill prompts |

### Mechanisms worth reimplementing (ideas only)

1. **Partial transcripts** (rpiv MIT) — UI-only until final; never LLM-submit partials.  
2. **Hallucination / silence filter** (rpiv MIT) — drop “Thanks for watching” class artifacts.  
3. **Silero VAD** (model MIT; po bundles it under BUSL product — use upstream Silero only).  
4. **Sample-rate fallback** when 16 kHz capture refused.  
5. **Echo-aware barge-in** (po docs) — study algorithm; reimplement under MIT/Apache if adopted.

### Rejected for now

- Drop-in **sherpa-onnx** without CPU/RAM/quality evidence vs current whisper.cpp.  
- Any **BUSL** source copy from po-voice.

## 2. Baseline latency (real lab probe — 2026-10-20)

**Script:** `scripts/phase36-latency-probe.mjs`  
**Clock:** `performance.now()` (monotonic)  
**Conditions:** Linux x64, Node v26.1.0; lab whisper-cli + ggml-small; Piper es_AR-daniela-high; **synthetic 1.5 s sine PCM** for STT (engine wall time, **not** ASR quality); TTS phrase 80 chars Spanish.

| Stage | Value | Kind |
| --- | --- | --- |
| VAD end-of-utterance (product config) | **1400 ms** audio (1200 hang + 200 post-roll) | Configured product delay |
| STT wall (`whisper-cli` + ggml-small) | **~3843 ms** | Measured |
| TTS wall (Piper, ~4 s audio out) | **~2233 ms** | Measured |
| Engine-only sum (VAD audio + STT + TTS) | **~7476 ms** | Derived |
| Playback PipeWire | *not measured* | Needs interactive session |
| First LLM delta | *not measured* | Would consume tokens |

**Interpretation:** After the user stops speaking, Gentle Voice still waits ~1.4 s of audio silence policy, then ~3.8 s STT on small model, then ~2.2 s TTS before any sound — **before** LLM time. Largest controllable wins: earlier VAD end, faster/partial STT, streaming TTS.

Human conversation RTT (mic → LLM → speaker) remains **unmeasured** until an approved interactive smoke (no fabricated numbers).

## 3. Incremental STT proposal

| Option | Pros | Cons | Fit |
| --- | --- | --- | --- |
| **A. whisper.cpp streaming / tiny+small cascade** | Keeps current stack; no sherpa | Streaming API maturity / bindings work | Prefer for first spike |
| **B. sherpa-onnx Whisper** (rpiv path) | Proven partials in Pi ecosystem | New native dep, ~157 MB+, CPU; license OK (MIT package) | Spike only with budget |
| **C. UI “provisional” from VAD segments + final whisper** | Smaller change | Not true partial ASR | Interim UX |

**Rule:** only **final accepted** transcript → `sendUserMessage`. Partials never increase LLM calls.

**Spanish / technical:** keep ggml language `es`; extend STT corrections list; measure WER on a fixed phrase set (no LLM).

## 4. Silero VAD evaluation

| | Energy VAD (today) | Silero ONNX |
| --- | --- | --- |
| Size | 0 | ~1–2 MB class ONNX |
| License (model) | n/a | MIT (upstream) |
| End-of-utterance | Fixed hang 1.2 s | Typically tighter with speech probability |
| Risk | Cuts / late hang | Needs ORT or small runner; false barge-in |

**Decision gate:** adopt Silero only if probe shows ≥20% reduction in end-of-utterance latency **without** raising cut-off WER on a Spanish phrase battery.

## 5. Portable Kokoro architecture (design)

As in `docs/kokoro-portable.md`, product path:

- `onnxruntime-node` (or vendored ORT) — **no** global Python.  
- Assets under `resolveGentleVoiceStorage()` with SHA-256 + consent.  
- Piper remains fallback and first-run default until clean-install smoke passes.  
- Lab Kokoro (`GENTLE_VOICE_LAB_*`) stays experimental and env-only.

**Blockers before default:** G2P/phonemizer for ES without system espeak; license of voice pack; cold-start latency vs Piper.

## 6. Compatibility & licenses

| Constraint | Status |
| --- | --- |
| Pi / GS storage isolation (3.4–3.5) | Must keep |
| Auto-install + purge/repair (3.5) | Must keep |
| No thinking/tools narration | Must keep |
| Anti-ghost submit gates | Must keep |
| rpiv MIT ideas | Reimplement OK |
| po-voice BUSL | No copy |
| Silero model MIT | OK with NOTICE |
| Kokoro weights | License review before ship |

## 7. Implementation priority (after audit approval)

1. **Latency timeline instrumentation** in `VoiceSession` (monotonic marks; `/gentle-voice status` optional dump).  
2. **VAD tune / Silero spike** with A/B metrics.  
3. **Partial STT spike** (whisper.cpp or sherpa) — UI only.  
4. **TTS continuity** (sentence assembler / gap reduction) on Piper.  
5. **Kokoro ONNX portable prototype** behind consent; Piper default.  
6. **Barge-in v1** (energy during playback + echo settle) before Silero barge-in.

## 8. Risks & required tests

| Risk | Mitigation |
| --- | --- |
| Double LLM submit from partials | Submit only finals; regression tests |
| Echo barge-in | Fail closed; Esc remains |
| Sherpa/ORT binary size | Consent + storage isolation |
| Breaking 3.5 uninstall/shortcuts | Branch from 3.5; keep 240+ tests green |
| Fake latency claims | Probe script + labeled conditions only |

**Automated tests (when coding starts):** partial mutate→final; no double submit; VAD end; TTS no duplicate chunks; barge-in cancel; Kokoro→Piper fallback; storage isolation.

**Human:** real conversation in Pi after engines land — user-owned.
