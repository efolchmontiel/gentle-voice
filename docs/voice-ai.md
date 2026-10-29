# Voice AI — narration role + second LLM (Phase 3.6)

## Profiles vs roles

| Concept | What it is |
| --- | --- |
| **Profile** | Named snapshot in `/gentle:profiles` (e.g. `OpenSource`) with an **orchestrator** + routing map |
| **Role** | Named entry *inside* a profile (Profile routing), e.g. `review-risk`, `voice-ai` |
| **Orchestrator** | Reserved key `orchestrator` — drives primary chat. **Not** a role |

`voice-ai` is a **role** under the active profile — never a sibling top-level profile.

Gentle Shell discovers roles from markdown under the session agent home (`agents/voice-ai.md`). A profile key without that file is reported as unmatched and ignored at launch. Gentle Voice creates or repairs the file on extension load, on session start, and on `/gentle-voice add voice-ai`, using the same agent home the host exposes (`GENTLE_PI_AGENT_HOME`, `GENTLE_SHELL_HOME`, or Pi's `~/.pi/agent`).

## Pipeline

1. Orchestrator (e.g. DeepSeek) produces the **written** reply (tools, agents, screen).
2. Gentle Voice resolves the narrator and makes a **second** model call (`after_settle`, final assistant text only):
   - **Pi standalone** — the active Pi model. No `profiles.json`, session binding, or frozen Gentle Shell profile unless `GENTLE_VOICE_USE_PROFILES=1` or `GENTLE_PI_CONFIG_HOME` is set.
   - **A** — Gentle Shell role `voice-ai` with model and thinking → that role
   - **B** — role has a model and no thinking → that model; thinking is not copied from the orchestrator
   - **C** — role exists with no model → profile orchestrator, second call
   - **D** — role absent → profile orchestrator, else the active model
   - **E** — Voice AI explicitly off → no second call; Speech Renderer only
   - **F** — invalid id, missing registry entry, or provider error → the reason is shown and Speech Renderer speaks the written reply. Models are not swapped silently.
3. Narrated text goes to the already selected TTS engine (VibeVoice PCM or Piper WAV). Changing the narrator does not change the voice. The visible reply is never rewritten. Code blocks are narrated (“left on screen”), not skipped. Credentials and destructive confirmations stay literal.

Narration stays `after_settle`. Pi `text_delta` is provisional: tools, thinking, and a later rewrite can still follow. There is no host event that marks a sentence as the final user-facing answer before `turn_end`. Starting Voice AI on those fragments would speak unconfirmed text. The barge microphone opens during `NARRATING` and `SYNTHESIZING`, and again during playback. It stays closed while the orchestrator is still in tools.

## Commands

```text
/gentle-voice add voice-ai          # empty voice-ai role on every existing profile; no model, no thinking
/gentle-voice voice-ai on|off|status
/gentle-voice voice-ai-profile   # lab only: seed OpenSource.voice-ai → MiMo (does not change orchestrator)
```

`/gentle-voice add voice-ai` adds the empty role and a `voice-ai` agent file so Gentle Shell can discover the key and `/gentle:profiles` can list it. The command does not create `profiles.json`. If that file is missing, create a profile with `/gentle:profiles` and run the command again. Model and effort are set on the `voice-ai` row in `/gentle:profiles` (or `/gentle:models`), then saved. When the profiles file already exists, extension load and the first session do the same.

The extra call is a second model request, billed apart from the orchestrator. `voice-ai` is the role name, not a model name. MiMo is one model that can fill it. Input is the assistant text clipped to 8000 characters. The default timeout is 25 seconds. One lab observation with MiMo was 363 input tokens and 9 output tokens. That figure is not a quota and it does not mean the model is free. Off, an invalid role, a provider error, or a timeout skips the extra call and uses the deterministic renderer. The written reply stays as the orchestrator wrote it.

Activation (not GS profiles):

| State | Narration LLM |
| --- | --- |
| Preference unset + `/gentle-voice converse on` | on (automatic) |
| Preference unset + normal chat | off |
| `/gentle-voice voice-ai on` | on (explicit; survives converse off) |
| `/gentle-voice voice-ai off` | off (explicit; converse does not re-enable) |
| `GENTLE_VOICE_AI=0` and preference still unset | process lock off |

Preference file: `$GENTLE_VOICE_HOME/voice-ai-preference.json`. Status resolves the profile even when narration is disabled.

## Config (`voiceAi.*`)

Model/effort live in `/gentle:profiles` (unified profiles panel on current Gentle Shell), not duplicated in GV config.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch |
| `role` | `voice-ai` | Routing role name |
| `fallback` | `orchestrator` | When role absent |
| `onError` | `deterministic` | Invalid / API error |
| `streaming` | `after_settle` | Wait for final text, narrate, then stream TTS |
| `timeoutMs` | `25000` | Narration budget |
| `maxInputChars` | `8000` | Clip input to narrator |

## Integration (no GS package import)

- Reads `profiles.json` schema (`gentle-pi.agent_model_profiles`)
- Optional session binding via `Symbol.for("gentle-pi:session-profile-bindings")`
- Inference via Pi `ExtensionContext.modelRegistry.complete` (tools-less, no history write)

## Pi standalone

`pi --extension` is `pi-standalone`. One active model, two calls: the written reply, then the narration. Switching the Pi model switches the next narration. A Gentle Shell profile on disk is not the narrator. TTS stays the installed engine. Voice AI turns on automatically while conversation is on, unless the preference or `GENTLE_VOICE_AI=0` says off. While the second call runs, the widget shows `NARRATING`.

## converse-style (separate)

`/gentle-voice converse-style` still injects `appendSystemPrompt` on the **same** orchestrator turn (style only). Prefer Voice AI for spoken naturalness without changing the written reply.
