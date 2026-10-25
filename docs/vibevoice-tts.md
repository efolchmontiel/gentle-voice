# VibeVoice Realtime

Optional TTS engine. The product install still speaks with Piper until you select VibeVoice. Selecting VibeVoice does not replace a written reply and does not silently fall back to Piper.

## Playback

When VibeVoice is the active engine and `pw-play` supports raw float32, playback is native PCM (mono, 24 kHz). That is the default. It is not a network server.

| Preference | Result |
| --- | --- |
| `auto` (missing file) | PCM when float32 playback works, otherwise WAV |
| `pcm` | PCM when supported, otherwise WAV with an explicit notice |
| `wav` | WAV |

```text
/gentle-voice stream status
/gentle-voice stream wav
/gentle-voice stream pcm
/gentle-voice stream auto
```

`GENTLE_VOICE_VIBEVOICE_NATIVE_STREAM=0` (also `off`, `false`, or `wav`) forces WAV for that process and overrides the preference file. `=1` requests PCM for that process. A real synthesis failure does not play the same sentence a second time as WAV.

Return to WAV with `/gentle-voice stream wav`.

## Engine

```text
/gentle-voice tts vibevoice
/gentle-voice tts piper
```

The engine switch lasts for the session. Piper stays available and does not require VibeVoice. `/gentle-voice tts vibevoice` reports the probe reason when the engine is not ready. You do not need lab mode.

## Install plan

`/gentle-voice vibevoice-setup` detects an NVIDIA GPU, total VRAM, free disk, and whether the destination is tmpfs. The confirm dialog is short. `vibevoice-setup plan` prints the full terms. Accepting the dialog authorizes the download. `GENTLE_VOICE_VIBEVOICE_ALLOW_NETWORK=0` refuses the network even after accept. The destination is the persistent Gentle Voice data directory, not `/tmp`. A verified file is kept and not downloaded again. The wizard does not modify an engine directory that already passes the probe.

A new install is blocked without an NVIDIA GPU, with less than 4 GB of total VRAM, or with less than 12 GiB free. The measured tree is 8211300352 bytes, about 7.6 GiB, and pip needs temporary space on top while installing. The installer adds only the worker's dependencies, runs pip without a cache, and deletes the source archive after the install. 8 GB of VRAM is recommended because that is the tested card. A larger card is not automatically supported. The preferred voice is `sp-Spk0_woman`. Playback is PCM when `pw-play` supports float32.

The weights are about 1.9 GiB (`model.safetensors` must be exactly 2035332888 bytes). The code origin is `https://github.com/microsoft/VibeVoice` (MIT, Copyright (c) 2025 Microsoft). The weights origin is `https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B`. `sp-Spk0_woman.pt` comes from `demo/voices/streaming_model/` in the VibeVoice code archive. `experimental_voices_sp.tar.gz` contains `sp/sp-Spk2_woman.pt` through `sp-Spk5_man.pt` and does not contain `sp-Spk0_woman.pt`. That archive is not downloaded. The model card is research-scoped and English-trained, and it is not recommended for commercial or real-world use without further testing. Keep the audible disclaimer and the watermark. The npm package does not contain the weights.

With `GENTLE_VOICE_VIBEVOICE_ALLOW_NETWORK=1` and an accepted confirm dialog, the command uses the network adapter. Without that flag it stops at `network_not_authorized` and does not write `authorized: true`. The manual steps below still work if you install the tree yourself. A new install uses Piper until VibeVoice is selected.

1. Pick a directory you own and export `GENTLE_VOICE_VIBEVOICE_HOME` to it.
2. Read the Microsoft model card and the MIT license for the code. Do not strip the audible disclaimer or the watermark. Spanish is outside the published training scope.
3. Create `.venv` inside that directory with a local Python 3.12, 3.13, or 3.14. Python 3.15 has no PyTorch wheel. Do not install into the system Python, and do not change system CUDA or drivers.
4. Install the VibeVoice runtime and a CUDA PyTorch build into that venv only.
5. Put the Realtime 0.5B weights at `models/VibeVoice-Realtime-0.5B/model.safetensors`.
6. Put `sp-Spk0_woman.pt` in `voices/` or in `code/demo/voices/streaming_model/`.
7. After those files exist and you accept the terms, write `INSTALL_PENDING.json` in the engine directory:

```json
{ "authorized": true, "status": "installed" }
```

Until that file says both of those values, the probe stays `awaiting_user_authorization` and Gentle Voice will not start the worker.

8. `/gentle-voice tts vibevoice` selects it for the session when the probe is `ready`. `/gentle-voice status` shows `vibevoiceReady`. `/gentle-voice tts piper` leaves VibeVoice uninstalled and stops a worker that was already started.

The worker script ships in this package. The engine directory's `scripts/lab_worker.py` wins when it is present. The worker refuses to start without `GENTLE_VOICE_VIBEVOICE_HOME`.

The shipped voice id is `sp-Spk0_woman`. This checkpoint is not a voice-cloning studio. Spanish is experimental. The model may speak an audible disclaimer; that watermark is kept.

## Resources

The worker stays resident after the first successful load. Esc cancels the current voice request and leaves the worker loaded. Closing the session disposes it and releases VRAM. Do not start the worker until a VibeVoice utterance is needed.

Cold load takes several seconds and needs a compatible NVIDIA GPU for the CUDA build used in the lab. A machine without that GPU can still use Piper. CPU and other GPU vendors are not a tested VibeVoice path.

## Limits

- First PCM frame time in an isolated generation is not the time until you hear speech.
- There is no acoustic echo cancellation.
- Windows and macOS are not a tested VibeVoice path.

### Device precision and startup errors

The default precision is automatic: BF16 on CUDA, because the checkpoint and
the voice cache are BF16, and FP32 on CPU. FP16 is only used when requested.
`GENTLE_VOICE_VIBEVOICE_DTYPE=auto|float16|bfloat16|float32` overrides the choice.
A worker load failure is reported using its structured Python error. It does
not retry the same failed engine boot as WAV; WAV recovery remains available
for failures in PCM transport after a successful boot.
