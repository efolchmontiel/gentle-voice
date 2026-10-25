# Third-party notices

Gentle Voice itself is MIT-licensed. Bundled **downloads** (not shipped inside the npm
tarball) come from upstream projects. First-run consent must surface these terms.

## Whisper.cpp

- Project: https://github.com/ggerganov/whisper.cpp
- License: MIT
- Models (ggml): derived from OpenAI Whisper weights; see upstream model cards.
- Default model pin: `ggml-base-q5_1.bin` from https://huggingface.co/ggerganov/whisper.cpp

## Piper TTS

- Project: https://github.com/rhasspy/piper
- License: MIT
- Includes espeak-ng data inside official release archives (see Piper NOTICE/licenses).

## Piper voice `es_AR-daniela-high`

- Source: https://huggingface.co/rhasspy/piper-voices
- Path: `es/es_AR/daniela/high/`
- Dataset: OpenSLR 61 — **Attribution-ShareAlike 4.0 International (CC-BY-SA-4.0)**
- MODEL_CARD notes training by larcanio / finetune from lessac US English.
- **Obligation:** if you redistribute this voice (including private caches published
  elsewhere), you must keep attribution and share-alike terms. Gentle Voice downloads
  it into the user's private data directory and does **not** re-upload the weights to npm.

## Silero VAD (optional)

- Model: https://github.com/snakers4/silero-vad — **MIT**
- Runtime (optionalDependency): `onnxruntime-node` — **MIT**
- Not required for install: without the model/runtime, Gentle Voice keeps energy VAD.
- Do not vendor BUSL wrappers from other Pi voice packages.

## VibeVoice Realtime 0.5B (optional engine)

- Code: https://github.com/microsoft/VibeVoice — **MIT**, Copyright (c) 2025 Microsoft.
- This npm package does **not** redistribute the model weights, the voice file, or a Python environment.
- The model card limits the weights to research use, states the training data is English, and requires keeping the audible disclaimer and watermark. Do not strip them.
- Spanish output is outside the published training scope. Treat it as experimental.
- Microsoft recommends disclosing that the speech is AI-generated and does not recommend commercial or real-world use without further testing.

## Kokoro (optional lab)

- Used only when present under a developer lab install.
- Not portable product default. Apache-2.0 (engine) — verify voice assets separately.
- Not announced as functional until a real portable implementation ships.

## FFmpeg (optional OS audio)

- Not downloaded by Gentle Voice.
- If the user installs ffmpeg for WASAPI/AVFoundation fallbacks, ffmpeg’s own LGPL/GPL
  terms apply to that binary — we only invoke it when already on PATH.
