# just-my-pi

Personal [pi](https://pi.dev) package: extensions and skills.

## Install

The repository is public, so the HTTPS form needs no SSH agent or credentials.

```bash
pi install git:github.com/namasme/just-my-pi
```

This tracks the default branch; `pi update --extensions` pulls the latest. Pin a tag
(e.g. `git:github.com/namasme/just-my-pi@v0.4.0`) when you want a fixed version.

Or reference it from `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/namasme/just-my-pi"]
}
```

## Contents

| Resource | Type | Notes |
|---|---|---|
| `report` | extension | Deterministic session reports. `/report` records the session as a Beads ticket with no LLM involved; `/triage-report` investigates eligible open tickets. Output goes to `~/pi/reports`, never into this repository |
| `heartbeat` | extension | On the main session, nudges the model to send a short status update if it has gone quiet (no user-facing text) for too long while still making tool calls. Threshold defaults to 10 minutes; override with `JUST_MY_PI_HEARTBEAT_SECONDS` |
| `cow-worktree` | skill | Creates APFS copy-on-write git worktrees, making branches of very large repositories cheap in time and disk. **macOS only** |
| `find-session` | skill | Hunt down a half-remembered pi/omp session by quoted fragments, topic, working-directory path, or timeframe. Scans both session stores (`~/.pi`, `~/.omp`), ranks candidates by how many clues they match, and returns the evidence trail — adjacent finds even on a miss. Requires `jq`; uses `rg` when present, falls back to `grep` |

## Selective loading

Load only part of the package with settings-level filtering. For example, on Linux, where the APFS-based skill cannot work:

```json
{
  "packages": [
    {
      "source": "git:github.com/namasme/just-my-pi",
      "skills": []
    }
  ]
}
```

## cow-worktree tests

```bash
cd extensions/cow-worktree/skills/cow-worktree
python3 -m unittest discover -s tests -p 'test_*.py'
```

Tests only ever operate inside their own lab directory; `tests/helpers.py` resolves every path with `realpath()` and refuses anything outside it.

## License

MIT

