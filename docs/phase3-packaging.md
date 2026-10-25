# Phase 3 — packaging & publication notes

## Pi package manifest

- `keywords` includes exact `pi-package` (gallery eligibility per https://pi.dev/docs/latest/packages).
- `pi.extensions`: `./extensions`
- `pi.image`: `./assets/gentle-logo-only.png`
- Host packages listed in `peerDependencies` with `"*"` (not bundled).
- `THIRD_PARTY_NOTICES.md` ships in the npm tarball (not the binaries themselves).

## Install sources (official)

```text
pi install npm:gentle-voice
gentle-shell install npm:gentle-voice
pi install git:github.com/efolchmontiel/gentle-voice@v0.1.1
```

Published line: **`0.1.0`** on npm `latest` (live).  
Prepared next: **`0.1.1`** (GS isolation) — publish only after PR merge + explicit approval.

Historical GitHub tag `v0.1.0-beta.1` is retained; it is not the npm `latest` line.

## Storage layout (phase 3.4)

Detection is **env-only** (what GS/Pi inject). Never scans disk for `~/.gentle-shell` to flip modes.

| Host | Storage root |
| --- | --- |
| Pi standalone | XDG / LocalAppData / Application Support `gentle-voice` |
| GS bundled (`GENTLE_SHELL_PREFIX` + agent under prefix) | `<prefix>/gentle-voice/` |
| GS isolated (`…/.gentle-shell/agent`) | `…/.gentle-shell/gentle-voice/` |
| GS `--link` (agent = `GENTLE_SHELL_USER_PI_HOME`) | portable Pi layout |
| GS `--home` / custom `GENTLE_SHELL_HOME` | `<agentHome>/gentle-voice/` |
| `GENTLE_VOICE_HOME` set | that path (nested cache) |

Never write into GS `versions/` or `runtime/`. See `/gentle-voice storage`.

## First-run (automatic)

- Triggered on `session_start`, first `/gentle-voice`, and shortcut — **not** only via `/gentle-voice setup`.
- Consent UI when the host exposes `ui.confirm`; else `GENTLE_VOICE_AUTO_DOWNLOAD=1` or setup/manual.
- Artifacts land under the resolved storage root (GS prefix when isolated/bundled; else XDG / LocalAppData / Application Support).
- When `GENTLE_VOICE_HOME` is set, cache is nested under that home (ambient lab `GENTLE_VOICE_CACHE` cannot leak).

## Clean Linux smoke

```bash
GENTLE_VOICE_SMOKE_PLAY=1 GENTLE_VOICE_SMOKE_MIC=1 \
  node --experimental-strip-types scripts/clean-home-linux-smoke.mjs
```

## Gallery (pi.dev)

Keyword `pi-package` makes the package **eligible** for https://pi.dev/packages. Indexing delay is unknown; verify after publish.

## Platform honesty

| Platform | Claim |
| --- | --- |
| Linux x64 | Experimental — clean install + real PipeWire I/O exercised |
| Windows x64 | Binaries pinned + ffmpeg WASAPI code path — **no real hardware validation** |
| macOS | Piper pinned; whisper-cli **missing** from official b5454 — STT auto-install blocked |

npm publication ≠ universal support.

## Release gate (human)

1. Revoke any previously exposed npm token; create a new one via `npm login` (do not paste tokens into chat).
2. `npm whoami` must succeed on the publishing account.
3. Confirm name `gentle-voice` ownership / availability.
4. Artifact URLs + SHA-256 in `lib/runtime/artifacts.ts`.
5. License review (`THIRD_PARTY_NOTICES.md`, Daniela CC-BY-SA-4.0).
6. Clean HOME smoke + PR merged to `main`.
7. Explicit approval for `npm publish --access public` (default `latest`).
