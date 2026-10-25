# Phase 3.5 — `pi remove` / ERR_PNPM_IGNORED_BUILDS + partial repair

## Root cause (verified)

`~/.pi/agent/settings.json` points `npmCommand` at **pi-npm-gate** + `pnpm`.

`pi remove` → gate **passthrough** → `pnpm` rebuild/uninstall of `~/.pi/agent/npm`.

`pnpm-workspace.yaml` **previously** had an invalid placeholder (repaired locally to `false`):

```yaml
allowBuilds:
  '@ast-grep/cli': set this to true or false   # ← INVALID (neither true nor false)
```

pnpm ≥11 then fails with `ERR_PNPM_IGNORED_BUILDS` for `@ast-grep/cli@0.45.0`.

**Owner of `@ast-grep/cli`:** transitive of **`pi-lens@4.3.0`**, not Gentle Voice.

**pi-npm-gate** does not invent `allowBuilds`; uninstall mode is passthrough.

### Fixture proof

| `allowBuilds['@ast-grep/cli']` | Result |
| --- | --- |
| `set this to true or false` | `ERR_PNPM_IGNORED_BUILDS` |
| `false` | pnpm ops proceed; **postinstall does not run** |
| `true` | postinstall runs (copies native `ast-grep` binary into place) |

## Can we fix without approving unnecessary scripts?

**Yes — two minimal options (pick one):**

### Option A — unblock only (`false`) — fewest privileges

```yaml
allowBuilds:
  '@ast-grep/cli': false
```

- Does **not** run the `@ast-grep/cli` postinstall.
- Enough to stop `ERR_PNPM_IGNORED_BUILDS` so `pi remove` / lockfile ops can finish.
- **Consequence:** if `ast-grep` was never linked, **pi-lens** features that shell out to the CLI may degrade until you later set `true` and reinstall.

### Option B — keep pi-lens CLI working (`true`) — still single package

```yaml
allowBuilds:
  '@ast-grep/cli': true
```

- Authorizes **only** that package’s postinstall.
- Inspected script (`postinstall.js`): resolves the platform optional package (`@ast-grep/cli-linux-x64-gnu`, …) and **link/copy** `ast-grep` / `sg` into the package dir. No network fetch inside the script; MIT-licensed CLI.
- Does **not** require `pnpm approve-builds --all`.
- `pi-lens: true` is already present separately in the same file.

**Do not** use `approve-builds --all`.

The agent must **not** edit your real `pnpm-workspace.yaml` without explicit approval.

## Partial uninstall state (verified read-only)

| Artifact | State |
| --- | --- |
| `settings.json` → `packages` | still has `npm:gentle-voice` |
| `npm/package.json` deps | **no** `gentle-voice` |
| `node_modules/gentle-voice` | **absent** |

→ Settings registered, npm package already gone.

## Verifiable repair (temp-first; you apply to real Pi)

1. **Fix allowBuilds** (Option A or B above) in `~/.pi/agent/npm/pnpm-workspace.yaml`.
2. **Unregister settings** using the packaged helper on a **copy** first:

```bash
# Dry-run on a copy (safe)
cp ~/.pi/agent/settings.json /tmp/settings-gv-repair.json
npx --package ./ gentle-voice-repair-settings --settings /tmp/settings-gv-repair.json
# Review output, then:
npx --package ./ gentle-voice-repair-settings --settings /tmp/settings-gv-repair.json --write
# Only after review, copy back — or point --settings at the real file with your approval:
# gentle-voice-repair-settings --settings ~/.pi/agent/settings.json --write
```

The CLI **refuses** to default to `~/.pi`; `--settings` is mandatory. `--write` creates `*.bak-gentle-voice-repair`.

3. Optional: `pi remove npm:gentle-voice` after allowBuilds fix (idempotent if already gone from npm).
4. Optional data purge: `gentle-voice-cleanup` (see below) — never automatic.

## Complete data cleanup (works without the npm package)

`bin/gentle-voice-cleanup.js` resolves storage from env the same way as the extension:

- **Pi standalone:** XDG `…/share|config|cache/gentle-voice`
- **GS isolated/bundled:** `<prefix>/gentle-voice/…`

Deletes only planned paths that contain a `gentle-voice` segment; refuses symlinks, Voxtype/WD-Black, GS `versions`/`runtime`. Requires `--confirm DELETE_GENTLE_VOICE_DATA`.

Preserve models for reinstall:

```bash
npx --package gentle-voice gentle-voice-cleanup --keep-models
npx --package gentle-voice gentle-voice-cleanup --keep-models --confirm DELETE_GENTLE_VOICE_DATA
```

Or while the extension is still installed: `/gentle-voice purge --keep-models` then confirm.
