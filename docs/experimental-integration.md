# Experimental integration with Pi (and optional Gentle Shell)

Gentle Voice is a **pi-package**. It does **not** require Gentle Shell. Gentle Shell is only a convenient host for compatibility tests.

## Phase 1C status

- Contracts, state machine, config schema, stub adapters, `/gentle-voice` registration.
- Engine manager: detection scenarios A–E, simulated install plans, hardware-aware model picks, setup modes.
- **Real filesystem probe** (`createFilesystemEngineProbe`) — read-only; reuses Piper + Voxtype ggml paths when present.
- Pi ExtensionAPI harness (commands, widget, `agent_settled`) without LLM tokens.
- **Piper TTS adapter** (dry-run by default; no playback). **Whisper STT adapter** prepared; unavailable until lab-local `whisper-cli`.
- **Whisper install consent** (`lib/engines/whisper-install-consent.ts`) — official prebuilt tarball to WD-Black only; **not executed**.
- Multiplatform audio backend catalog (PipeWire/Pulse, WASAPI, CoreAudio/AVFoundation) — stubs only implemented.
- Shortcut gate: fail-closed; lab double-gate `GENTLE_VOICE_LAB=1` + `GENTLE_VOICE_LAB_SHORTCUT=1` (harness only until live TUI).
- Live GS TUI: checklist in `gs-lab/TUI-CHECKLIST.md` — **pending human evidence**.
- **No** real microphone capture, **no** TTS playback, **no** downloads until explicit authorization.

## Official lab paths (this machine)

| Role | Path |
| --- | --- |
| Plugin | `/home/erickfm/D-SSD/personal/projects/gentle-voice` |
| Experimental Gentle Shell | `/home/erickfm/D-SSD/personal/projects/gentle-shell` |
| Lab home | `/home/erickfm/D-SSD/personal/gs-lab` |
| Models/cache | `/home/erickfm/WD-Black/gentle-voice` |

Do **not** modify the daily Gentle Shell, global Pi settings, or existing Piper/Voxtype installs.

## Portable paths

| Variable | Purpose |
| --- | --- |
| `GENTLE_VOICE_HOME` | Config/state root |
| `GENTLE_VOICE_MODELS` | Model files root |
| `GENTLE_VOICE_CACHE` | Cache |
| `GENTLE_VOICE_TMP` | Temp |
| `GENTLE_VOICE_CONFIG` | Explicit config JSON path |

## Tests (no tokens)

```bash
cd /home/erickfm/D-SSD/personal/projects/gentle-voice
node --experimental-strip-types --test tests/*.test.ts
```

## Load against plain Pi (lab only)

```bash
export PI_CODING_AGENT_DIR="/home/erickfm/D-SSD/personal/gs-lab/agent"
export GENTLE_VOICE_HOME="/home/erickfm/D-SSD/personal/gs-lab/voice-home"
export GENTLE_VOICE_MODELS="/home/erickfm/WD-Black/gentle-voice/models"
export GENTLE_VOICE_CACHE="/home/erickfm/WD-Black/gentle-voice/cache"

pi --extension /home/erickfm/D-SSD/personal/projects/gentle-voice/extensions/voice.ts
```

```text
/gentle-voice status
/gentle-voice config
```

## Load against Gentle Shell (compatibility lab only)

```bash
export GENTLE_SHELL_NO_AUTO_SETUP=1
export GENTLE_SHELL_CONFIG="/home/erickfm/D-SSD/personal/gs-lab/launcher-config.json"
export GENTLE_VOICE_HOME="/home/erickfm/D-SSD/personal/gs-lab/voice-home"
export GENTLE_VOICE_MODELS="/home/erickfm/WD-Black/gentle-voice/models"

gentle-shell --home /home/erickfm/D-SSD/personal/gs-lab/agent \
  -e /home/erickfm/D-SSD/personal/projects/gentle-voice/extensions/voice.ts
```

Do **not** use `--link` against your daily Pi home for experiments.

## Next phase (blocked without authorization)

1. Real engine download/install behind consent UI.
2. Wire capture/STT/TTS adapters to Whisper.cpp + Piper.
3. Persist first-run setup + change detection.
4. Live shortcut verification against the host terminal.
