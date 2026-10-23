# Changelog

All notable changes to Gentle Voice are documented here.

## [Unreleased]

### Added

- On WSL2 with WSLg, `/gentle:voice setup` connects PipeWire to the Windows microphone. Before, it only said `Microphone missing`. It names the exact missing piece: WSLg, the PipeWire packages (as an `apt` command it does not run), a hung WSLg audio server, or the Windows microphone permission. After a confirm, it writes one user-level pulse-tunnel drop-in and enables the PipeWire user services. The tunnels are `nofail`, so a down WSLg server never keeps PipeWire from starting, and a bridge that did not load is offered a service restart. Native Linux is unchanged. (#13)

## [0.1.8] — 2026-10-21

### Fixed

- `/gentle:models` lists `voice-ai`. The panel only shows agents that have a markdown file, so an empty profile role never appeared there. The file is created without a model. Saving a model and an effort in that panel is what the narrator uses.

## [0.1.7] — 2026-10-21

### Added

- An existing Gentle AI `profiles.json` receives an empty `voice-ai` role on every profile. The role has no model and no thinking. Those are set in `/gentle:models`. A missing profiles file is not created. `/gentle:voice add voice-ai` performs the same add. Pi and an isolated Gentle Shell each write only their own profiles file.

## [0.1.6] — 2026-10-21

### Fixed

- VibeVoice creates its private `.venv` with Python 3.10–3.14, preferring 3.14 when it is installed. `python3` on this machine is 3.15, and PyTorch publishes no wheel for it, so pip reported `No matching distribution found for torch`. An existing 3.15 environment is discarded and created again.

## [0.1.5] — 2026-10-21

Published to npm as `gentle-voice@0.1.5`. npm `latest` is `0.1.5`. The same package is installed with `pi install npm:gentle-voice` or `gentle-shell install npm:gentle-voice`.

### Added

- VibeVoice Realtime 0.5B as an optional engine, with a short consent dialog, private `.venv`, pinned hashes, and `sp-Spk0_woman` taken from the code archive.
- Persistent engine directory under the XDG data home. A tmpfs destination, including `/tmp`, is refused unless explicitly allowed.
- Separate first-run questions for speech recognition and for Piper or VibeVoice. The selector names the engines. The recommended one is listed first because Pi highlights row 0. A failed GPU probe stays unknown. A tmpfs override is shown and is not the default destination.
- VibeVoice install progress stays on screen as a checklist. Reused files are not shown as new downloads. The engine is activated in the current Pi session after verification. `Ready to use` is reserved for that active state. `/gentle:voice status` and `vibevoice-setup plan` do not wait for pip. `vibevoice-setup cancel` stops it. A partial tree is resumed. The receipt is written only after the pinned files, the private environment, and a worker process probe that does not load the GPU model.
- Native PCM playback for VibeVoice when `pw-play` supports float32. `/gentle:voice stream wav` keeps WAV.
- `/gentle:voice voice-ai`, `barge-in`, `tts`, `stream`, and `vibevoice-setup`.
- Voice AI narrates the final assistant text through a profile role named `voice-ai`. The role is not a model. The extra call is billed separately. Invalid, failed, or timed-out narration uses a deterministic renderer.
- Silero VAD with an energy fallback, optional incremental speech-to-text, and a small local correction lexicon.
- First `Esc` while voice is busy cancels only the voice channel.

### Notes

- Piper stays the engine until a VibeVoice install is accepted and the preference is not Piper.
- Weights, voices, and the VibeVoice tree are not in the npm tarball.
- A clean VibeVoice install on Linux x64 was confirmed in use, including playback. Weights stay out of the npm tarball. The Spanish voice file is taken from the VibeVoice code archive, not from the weights repo.
- Windows, macOS, CPU, and non-NVIDIA GPUs are not a tested VibeVoice path.
- CI runs the suite on Ubuntu, macOS, and Windows. PipeWire capture and a tmpfs install refusal stay Linux behavior. macOS and Windows are still not supported audio hosts.

## [0.1.4] — 2026-10-20

### Fixed

- Esc / `cancelVoiceAudio` no longer crashes Pi with an uncaught `AbortError` when PipeWire capture is aborted before `stop()` is awaited (Esc → Ctrl+Alt+Space).

## [0.1.3] — 2026-10-20

Same Phase 3.5 release as 0.1.2. Republished because npm registry ghost-staged `0.1.2` (CLI printed success, packument never listed it; subsequent publishes hit E409 / “previously published”, and `npm stage list` is empty — known npm CLI/registry issue). Install **0.1.3** as latest.

### Notes

- CLI bins are `bin/*.js` so npm 11 keeps the `bin` field on publish.
- README documents install / uninstall / cleanup / `--keep-models`.

## [0.1.2] — 2026-10-20

Phase 3.5 — production conversation UX, honest status, safe uninstall/cleanup.

### Added

- Product Ctrl+Alt+Space / Ctrl+Alt+E registration without `GENTLE_VOICE_LAB*` (opt-out: `GENTLE_VOICE_DISABLE_SHORTCUTS=1`).
- `/gentle:voice converse on|off` as a product command (hands-free session).
- `/gentle:voice purge` + `gentle-voice-cleanup` CLI for optional private-data removal with explicit confirm token.
- `--keep-models` on purge / `gentle-voice-cleanup` — preserve private `models/` (STT models + TTS voices) while removing binaries, config, cache, and tmp.
- Docs: `docs/phase35-uninstall-pnpm.md`, `docs/phase35-voice-refs.md`.

### Changed

- Conversation sessions enable fluent + auto-submit by default (opt-out: `GENTLE_VOICE_DISABLE_AUTO_SUBMIT=1`).
- Help/status no longer present “phase 2C”; status distinguishes engine readiness, conversation, registered shortcuts vs OS key delivery.
- Dictation still requires explicit `/gentle:voice send`.

### Fixed (pre-publish)

- Cleanup deletes Pi XDG **config** + **cache** gentle-voice roots, not only `share/` (complete remove).
- `gentle-voice-repair-settings` repairs partial unregister (`settings` vs npm) without defaulting to `~/.pi`.
- Windows CI path asserts in cleanup tests (normalize `\` vs `/`).
- CLI bin paths use `.js` (npm 11 was stripping `.mjs` bin entries on publish).
- README documents install, uninstall, purge/cleanup, and `--keep-models`.

### Notes

- Does not overwrite published `0.1.1`. Windows / macOS / portable Kokoro still unsupported claims.
- `pi remove` + `ERR_PNPM_IGNORED_BUILDS` is a Pi/`allowBuilds` + `pi-lens`→`@ast-grep/cli` issue — see uninstall doc.

## [0.1.1] — 2026-10-19

Gentle Shell isolation + lab-path hard gate for published product behaviour.

### Added

- `resolveGentleVoiceStorage()` — env-only host detection (Pi standalone, GS bundled, GS isolated, `--link`, custom `--home`, explicit overrides).
- Storage under `<GENTLE_SHELL_PREFIX>/gentle-voice/` (or `~/.gentle-shell/gentle-voice/`) with `bin/`, `models/`, `config/`, `cache/`, `tmp/`, `logs/`.
- `/gentle:voice storage` — diagnostics + optional data-cleanup dry-run (never deletes automatically).
- `isGentleVoiceLabPathsAllowed()` + `lib/runtime/lab-paths.ts` — lab paths only from env (no hard-coded homes in the tarball).
- Isolation + lab-gate regression tests (temporary HOME/prefix sentinels; no real Pi/GS mutation).
- Design doc: `docs/kokoro-portable.md` (ONNX Runtime path; no downloads in this release).

### Changed

- Inside GS isolated/bundled sessions, first-run downloads no longer use ambient `~/.local/share/gentle-voice` / XDG paths (unless `GENTLE_VOICE_*` overrides).
- `--link` keeps the portable Pi layout (does not treat GS prefix alone as isolation).
- `labKokoroPresent()` returns false without probing disk when lab is OFF.
- Filesystem engine probe no longer scans third-party/lab trees unless lab env is set.
- Product TTS default remains **Piper**; Kokoro stays lab-only (env-configured) until a portable ONNX ship.
- `lib/lab/*` and machine-specific docs excluded from the npm tarball.

### Notes

- Does **not** publish over `0.1.0`; patch `0.1.1` only after PR merge + explicit publish authorization.
- Windows / macOS remain unsupported pending real hardware smoke.
- Existing external lab models are **not** deleted or modified.

## [0.1.0] — 2026-10-19

First stable npm release (`latest`). Linux first-run path is experimental but installable; Windows and macOS are **not** claimed as supported.

### Added

- Automatic first-run on host `session_start` / first voice command (consent-gated downloads).
- Pinned Whisper.cpp + Piper + `es_AR-daniela-high` artifacts with SHA-256 verification.
- Private XDG / LocalAppData / Application Support layout (`GENTLE_VOICE_HOME` nests cache).
- Portable ffmpeg WASAPI / AVFoundation adapters (code only — **unverified** on hardware).
- `THIRD_PARTY_NOTICES.md` (including CC-BY-SA-4.0 obligations for Daniela).
- Clean-HOME Linux smoke script for maintainers.

### Fixed

- Ambient lab `GENTLE_VOICE_CACHE` no longer leaks into private `GENTLE_VOICE_HOME` installs (cross-device EXDEV).

### Compatibility (honest)

| Platform | Status |
| --- | --- |
| Linux x64 | Experimental — clean install + PipeWire exercised |
| Linux arm64 | Planned / bins pinned |
| Windows x64 | Blocked for conversation — bins pinned, no hardware smoke |
| macOS | Blocked — no official whisper-cli in pinned whisper.cpp release |

### Notes

- Historical GitHub release `v0.1.0-beta.1` remains for reference; this `0.1.0` supersedes it on npm `latest`.
- Publishing does **not** imply universal OS support.

## [0.1.0-beta.1] — 2026-10-19

Portable runtime scaffolding, pinned engines catalog, Pi package metadata (`pi-package`), GitHub release tag only (npm beta publish was not completed).
