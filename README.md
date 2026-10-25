<div align="center">
  <img src="assets/gentle-logo-only.png" alt="Gentle Voice" width="132" />

# Gentle Voice

**Speak with Pi. Hear the reply. Stay local for the audio.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

Gentle Voice is a [Pi package](https://pi.dev/docs/latest/packages) for conversation: microphone, speech-to-text, and text-to-speech. It runs inside Pi Coding Agent on its own, and inside Gentle Shell when that host is present. Gentle Shell is not required.

[`gentle-voice@0.1.8`](https://www.npmjs.com/package/gentle-voice) is the published npm package for both hosts. npm `latest` is `0.1.8`. Pi lists it at [pi.dev/packages/gentle-voice](https://pi.dev/packages/gentle-voice). Cloning this repository is not the install.

## Demo

Screen recording of Gentle Voice. Unmute to hear the audio.

https://github.com/user-attachments/assets/f5892e57-ab71-4e04-9904-a0b35b091229

## Install

Node.js ≥ 22.19. The tested audio path is Linux x64 with PipeWire. Windows and macOS are not supported.

### Pi Coding Agent

```bash
pi install npm:gentle-voice
```

Pi does not need Gentle Shell. Voice AI uses the model that is active in that Pi session. It does not read Gentle AI profiles.

### Gentle Shell

```bash
gentle-shell install npm:gentle-voice
```

Gentle Shell does not need a separate `pi install`. It installs the same `gentle-voice` package.

The active Gentle AI profile must have a role named `voice-ai`. `voice-ai` is the role name, not a model name. When `profiles.json` already exists, the first session adds an empty `voice-ai` role to every profile and a `voice-ai` agent file so `/gentle:models` lists it. The role starts without a model or a thinking level. Open `/gentle:models`, select `voice-ai`, and save the model and the effort. That saved assignment is what the narrator uses. If the profiles file does not exist, nothing is created there. Create a profile with `/gentle:profiles`, then run `/gentle:voice add voice-ai`.

```json
"voice-ai": {}
```

After you assign a model, the entry looks like this. Thinking is optional:

```json
"voice-ai": { "model": "provider/model-id", "thinking": "low" }
```

That model writes the spoken line. The orchestrator model keeps writing the text on screen. Thinking on the role is optional. When it is omitted, the narrator does not copy the orchestrator's thinking. If the role exists but has no model, the second call uses the profile orchestrator. If the role is missing, the profile orchestrator is used, then the active Pi model. An invalid id or a provider error is shown, and the written reply is spoken as-is. Models are not swapped silently.

Restart the host after installing.

The first launch does not download models by itself. The voice-engine list is `VibeVoice`, `Piper`, and `Skip`. Pi highlights the first row, so the recommended engine is listed first with `(Recommended for your system)`. VibeVoice is recommended only when Linux x64, an NVIDIA GPU of at least 4 GB, 12 GiB free, and `python3` are confirmed. A failed GPU check is labeled `(Compatibility unknown)` and does not count as proof that the GPU is missing. Piper is the recommendation in that case, and when VibeVoice is `(Not supported)`, as long as Piper itself can run. Choosing an engine does not start a download. The install, finish, or repair question comes next. After Yes, Pi keeps a checklist on screen: each real step stays visible as Pending, Running, Completed, Failed, Reused, or Skipped. Notifications are not the progress view. When the checklist finishes, the engine is selected in the current session. `Ready to use` is shown only after that activation. No audio is played. `/gentle:voice status` and `/gentle:voice vibevoice-setup plan` stay available while that runs. `/gentle:voice vibevoice-setup cancel` stops it and keeps verified files. The next launch does not ask again when the install is already verified. Whisper is a separate question. An explicit Piper or VibeVoice choice is kept. `/gentle:voice setup` repeats the check. It does not install GPU drivers, CUDA, or a system Python.

Do not pass `--extension` to a Pi that already has `npm:gentle-voice` installed. Pi would register `/gentle:voice` twice. Install with `pi install npm:gentle-voice` or `gentle-shell install npm:gentle-voice`. Both commands install that same npm package.

## First session

| Step | What you do |
| --- | --- |
| Turn voice on | `Ctrl+Alt+Space` or `/gentle:voice converse on` |
| Speak | The microphone stays off until a session starts |
| Hear the reply | Piper speaks it until you finish a VibeVoice install and keep that engine |
| Stop the audio | `Esc` once, while voice is busy |
| Edit what you said | `Ctrl+Alt+E` or `/gentle:voice edit` |

Opt out of the chords with `GENTLE_VOICE_DISABLE_SHORTCUTS=1`.

## What you can do

- **One utterance.** `/gentle:voice listen`, then `/gentle:voice send` if you are in dictation.
- **Hands-free.** `/gentle:voice converse on`. Speech end submits, the reply is spoken, then it listens again.
- **Edit.** `/gentle:voice edit` loads the pending or last voice line into the Pi editor.
- **Narration.** The written answer stays as the model wrote it. Speech is a separate step.

## Speech detection

`GENTLE_VOICE_VAD=auto` (the default) uses Silero when `silero_vad.onnx` is available, and the energy detector otherwise. `energy` forces the energy detector. `silero` still falls back to energy if the model cannot load, and status reports why. The ONNX file is not in the npm package.

## Speech to text

Whisper runs locally after you accept its download. The transcript that can be sent is the final one. Incremental speech-to-text is off unless `GENTLE_VOICE_INCREMENTAL_STT=1` (or the config flag). While it is on, provisional text is only for the screen. It is not submitted. A short local lexicon rewrites a few known mishearings, such as the product name and `C#`, after Whisper returns. It does not edit the Whisper model.

## Commands

| Command | Effect |
| --- | --- |
| `/gentle:voice` | Toggle on, or show status if already on |
| `/gentle:voice on` / `off` | Enable, or stop and cancel audio work |
| `/gentle:voice converse on` / `off` | Hands-free session. `off` keeps installed engines |
| `/gentle:voice listen` | One listen window |
| `/gentle:voice stop` | Stop listen or speech and return to idle |
| `/gentle:voice mute` | Mute TTS. The microphone can stay on |
| `/gentle:voice send` | Send the pending transcript |
| `/gentle:voice draft <text>` | Replace the pending transcript |
| `/gentle:voice edit` | Open the voice line in the editor |
| `/gentle:voice status` | Engines, conversation, shortcuts, storage |
| `/gentle:voice config` | Effective paths |
| `/gentle:voice setup` | Readiness. Downloads only after you accept |
| `/gentle:voice storage` | Where this host keeps private data |
| `/gentle:voice purge` | Show the delete plan. Nothing is removed until you confirm |
| `/gentle:voice stream auto\|pcm\|wav` | VibeVoice playback. See below |
| `/gentle:voice tts piper\|vibevoice` | Engine for this session |
| `/gentle:voice vibevoice-setup` | Short confirm, then install. `plan` prints the full terms |
| `/gentle:voice voice-ai on\|off\|status` | Optional second model that writes the spoken text |
| `/gentle:voice add voice-ai` | Add an empty `voice-ai` role to every existing profile, and list it in `/gentle:models` |
| `/gentle:voice barge-in on\|off\|status` | Interrupt playback by speaking |

`/gentle:voice tts kokoro` exists only when a lab Kokoro install is present. It is not the product default.

## Esc

The first `Esc` while voice is listening, loading, synthesizing, or speaking cancels that voice channel. It does not abort the agent. A later `Esc`, once voice is idle, is left for Pi. Gentle Voice does not swallow `Esc` when it has nothing to cancel.

## Voice AI

Voice AI writes a short spoken version after the agent settles. It does not change the text on screen and it does not add an agent turn. The second call starts only after the orchestrator has finished. Narration does not begin on partial text.

On Pi alone, the narrator is the active Pi model. Switching that model switches the next narration. A Gentle AI profile on disk is not read.

On Gentle Shell, the empty `voice-ai` role is added to every existing profile. Assign its model and effort in `/gentle:models`, or run `/gentle:voice add voice-ai` when the profiles file was created later. That assigned model is the narrator. It is not replaced by the active Pi model while the role has a valid model.

| Situation | What happens |
| --- | --- |
| Pi, no profile opt-in | The active Pi model writes the spoken text |
| Role `voice-ai` has a model | That model writes the spoken text |
| Role has a model and no thinking | That model. Thinking stays unset |
| Role exists, no model | The profile orchestrator writes it |
| Role is missing | The profile orchestrator, then the active Pi model |
| Invalid id, missing model, or provider error | The reason is shown. The written reply is spoken |
| `/gentle:voice voice-ai off` | No extra model call |

The narrator is a second model call. It is billed on top of the orchestrator, at that narrator's own provider rates. The call sends the assistant text, clipped to `voiceAi.maxInputChars` (8000 characters), and receives only the spoken line. It does not send tool history, it does not write the conversation history, and it does not change the text on screen. Cost follows the provider, the price, the context, and the length of the answer. One lab turn with MiMo used 363 input tokens and 9 output tokens. That turn is not the cost of every conversation, and it does not mean MiMo is free. A smaller narrator is usually cheaper. `/gentle:voice voice-ai off` skips the extra call.

The narrator uses whatever provider that model already uses. That can be a remote API. Speech recognition and speech synthesis stay on the machine. Do not treat the whole turn as offline.

`/gentle:voice voice-ai off` persists. Unset follows the conversation session. `GENTLE_VOICE_AI=0` locks it off while the preference file is unset.

## VibeVoice

VibeVoice is optional. Piper does not need it, and a missing VibeVoice install does not block Piper.

When VibeVoice is selected and `pw-play` can play raw float32, playback is native PCM. You do not set an environment variable for that. `/gentle:voice stream wav` saves WAV for this install. `/gentle:voice stream auto` returns to the default. For one process, `GENTLE_VOICE_VIBEVOICE_NATIVE_STREAM=0` forces WAV and wins over the file.

If PCM is not supported, VibeVoice uses WAV and says so. It does not switch to Piper. If PCM already started and synthesis fails, the same sentence is not played again as WAV.

On a compatible machine, `/gentle:voice vibevoice-setup` asks with a short confirm. Accepting that dialog is the download authorization. `vibevoice-setup plan` prints the licenses, hashes, and file list before you accept. The simulated tests do not fetch from Hugging Face. A real weights download in `/tmp` reached the verified `model.safetensors` and then stopped, because the experimental Spanish archive does not contain `sp-Spk0_woman.pt`. That voice is `demo/voices/streaming_model/sp-Spk0_woman.pt` inside the VibeVoice code archive. The installer now takes it from there and resumes files whose hash already matches. Declining, or hardware that fails the floor, leaves Piper in place and does not delete an engine you already have.

The engine directory is `$XDG_DATA_HOME/gentle-voice/vibevoice`, or `~/.local/share/gentle-voice/vibevoice` when `XDG_DATA_HOME` is unset. `GENTLE_VOICE_HOME` and `GENTLE_VOICE_VIBEVOICE_HOME` are optional overrides. If the resolved directory is on tmpfs, including `/tmp`, Pi asks before using it and offers the persistent directory. The variables themselves are not changed. `GENTLE_VOICE_VIBEVOICE_ALLOW_TMPFS=1` is only for a throwaway test.

The floor is an NVIDIA GPU, 4 GB of VRAM, and 12 GiB free. The one measured tree was about 8.6 GiB, so 8 GiB free is not enough. 8 GB of VRAM is the recommended and tested class: one Linux x64 machine with an RTX 2070. A card above 4 GB is not automatically supported. Windows, macOS, CPU, and other GPUs are not supported by a run we can cite.

The code commit is `16fb2cb1217c9934a886e1948ffb06120caa2df5` from `https://github.com/microsoft/VibeVoice` (MIT). The weights are `model.safetensors`, 2035332888 bytes, sha256 `7758b150b8139deb48ac1ff6f181f745c8fedd5511232fd974b3eb217d83b514`, from `https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B`. The voice file is `sp-Spk0_woman.pt` from the upstream experimental Spanish archive. Those hashes are checked before `INSTALL_PENDING.json` is written. The npm package does not contain the weights. The Python environment is `<engine>/.venv`. The wizard does not use sudo and does not change system Python, CUDA, or drivers.

`/gentle:voice tts vibevoice` selects it when the probe is ready and stores that choice. `/gentle:voice tts piper` stores Piper and stops the worker. Asking `/gentle:voice status` does not download. A partial tree is retried by running the wizard again; files whose hash already matches are not fetched twice. Uninstall removes the pinned files, the receipt, the marker, and `.venv` only when `integrity.json` is present and the confirm token is passed to the library. It does not delete unrelated files, and it will not remove an older engine that has no receipt. Details: [docs/vibevoice-tts.md](docs/vibevoice-tts.md). When the probe is ready, `/gentle:voice tts vibevoice` works without lab mode. The worker starts on the first VibeVoice utterance and stays loaded until the session closes. Expect a multi-second cold load and a few gigabytes of VRAM on the one NVIDIA GPU where this was tested. CPU and other GPUs are not a tested VibeVoice path.

The checkpoint is English-trained. Spanish is experimental. The audible disclaimer and watermark stay. This is not a voice-cloning tool. Details: [docs/vibevoice-tts.md](docs/vibevoice-tts.md).

## Piper

Piper is the engine that installs with the consented voice download. It does not need a GPU. Use `/gentle:voice tts piper` to return to it. That stops the VibeVoice worker.

## Barge-in

During conversation, speaking can interrupt narration, synthesis, and playback. The gate is microphone energy, not echo cancellation. There is no acoustic echo canceller. Whisper receives audio from the detected speech onset, not the whole time the microphone was open. If that onset cannot be separated from playback, nothing is sent. `/gentle:voice barge-in off` stays off until you turn it on. The microphone stays closed while the orchestrator is still running tools.

## What gets spoken

The spoken reply is the assistant text you would read. Thinking and tool calls stay silent. An approval prompt is one fixed sentence: the agent needs your authorization. It is not a second agent turn.

A later message that did not come from the voice turn is not spoken automatically. Background jobs, subagents, and host work that never surfaces as that assistant text are not narrated.

## If something fails

`/gentle:voice status` and `/gentle:voice setup` are the starting point.

| Symptom | Check |
| --- | --- |
| No microphone | PipeWire session, device permission, capture not started. On WSL2, see below |
| No speech model | Setup consent was declined, or the download failed |
| No VibeVoice | `GENTLE_VOICE_VIBEVOICE_HOME` missing or incomplete. Piper still works |
| CUDA error | Use Piper, or fix the engine outside this package. Do not expect Gentle Voice to repair drivers |
| PCM refused | `pw-play` has no float32. `/gentle:voice stream wav` |

### WSL2 with WSLg

WSLg exposes the Windows microphone and speakers only through its PulseAudio server (`RDPSource`, `RDPSink`). Capture uses `pw-record`, so PipeWire has to reach that server. On WSL, `/gentle:voice setup` checks each step and stops at the first one that fails:

| Step | What setup does |
| --- | --- |
| No `/mnt/wslg/PulseServer` | Asks you to run `wsl --update` in Windows |
| PipeWire missing | Prints `sudo apt install pipewire pipewire-bin wireplumber pulseaudio-utils`. It never runs sudo |
| WSLg audio server hung | Asks you to run `wsl --shutdown` in Windows |
| No `RDPSource` | Points to Windows Settings → Privacy & security → Microphone, then `wsl --shutdown` |
| No bridge yet | After you confirm, writes `~/.config/pipewire/pipewire.conf.d/gentle-voice-wslg.conf` and runs `systemctl --user enable --now pipewire.socket pipewire.service wireplumber.service`, then restarts both services |
| Bridge configured, no source in PipeWire | After you confirm, runs `systemctl --user restart pipewire.service wireplumber.service` |

A PipeWire graph that already lists an audio source counts as ready, wherever its tunnel is configured. The bridge is user-level only. Both tunnels are `nofail`: if WSLg's audio server is down when PipeWire starts, PipeWire still starts without them, and the next setup offers the restart. An existing drop-in that already points at `/mnt/wslg/PulseServer` is reused. `pipewire-pulse` is not enabled, because `PULSE_SERVER` already points at WSLg. The user services need `systemd=true` under `[boot]` in `/etc/wsl.conf`.

## Where data lives

Standalone Pi uses the XDG data, config, and cache directories for `gentle-voice` on Linux (`~/.local/share/gentle-voice`, `~/.config/gentle-voice`, `~/.cache/gentle-voice`). VibeVoice lives under the data directory, in `vibevoice/`. Gentle Shell uses `<prefix>/gentle-voice/`. Preferences stay in the data directory, outside the npm package, so an update does not wipe them. Models are not inside the npm package. `/gentle:voice storage` prints the resolved paths. A path under `/tmp` is not a permanent install.

Removing the package keeps that data:

```bash
pi remove npm:gentle-voice
gentle-shell remove npm:gentle-voice
```

`/gentle:voice purge` lists what a data delete would remove. Add `--confirm DELETE_GENTLE_VOICE_DATA` only when you mean it. `--keep-models` leaves models and voices. The standalone CLIs `gentle-voice-cleanup` and `gentle-voice-repair-settings` are documented in [docs/phase35-uninstall-pnpm.md](docs/phase35-uninstall-pnpm.md). Cleanup refuses paths that are not this host's Gentle Voice data.

## Privacy

Speech-to-text and Piper or VibeVoice synthesis run locally. Voice AI can call a remote model. Transcripts are not written to the default log. There is no telemetry in this package.

## Support

| Path | State |
| --- | --- |
| Linux x64, PipeWire, Piper, Whisper | Tested in development |
| Linux x64, VibeVoice PCM on NVIDIA CUDA | Tested on one lab GPU. Experimental, especially in Spanish |
| Linux x64 on WSL2 + WSLg, PipeWire bridge | Tested once on Ubuntu 24.04, PipeWire 1.0.5. Experimental |
| Linux arm64 | Not tested here |
| Windows, macOS | Not supported |

A GPU is not required to install or to use Piper.

## Licenses

Gentle Voice is MIT. See [LICENSE](LICENSE). Whisper, Piper, Daniela, Silero, and VibeVoice keep their own terms. Weights are not in the npm tarball. Read [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before you accept a download. Daniela's voice is CC-BY-SA-4.0. VibeVoice weights are research-scoped and English-trained; keep the watermark.

## Development

```bash
git clone https://github.com/efolchmontiel/gentle-voice.git
cd gentle-voice
pnpm install
pnpm test
pnpm typecheck
npm pack --dry-run
```

Issues and pull requests: [CONTRIBUTING.md](CONTRIBUTING.md).

https://github.com/efolchmontiel/gentle-voice/issues
