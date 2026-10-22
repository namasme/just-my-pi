# just-my-pi

Personal [pi](https://pi.dev) and omp package: extensions and skills.

## Install

The repository is public, so the HTTPS form needs no SSH agent or credentials.

```bash
pi install git:github.com/namasme/just-my-pi
```

This tracks the default branch; `pi update --extensions` pulls the latest. Pin a tag
(e.g. `git:github.com/namasme/just-my-pi@v0.5.0`) when you want a fixed version.

Or reference it from `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/namasme/just-my-pi"]
}
```

For omp, install from GitHub with `omp plugin install https://github.com/namasme/just-my-pi`. To refresh an existing GitHub-sourced install, run `bun update just-my-pi --force --no-cache` from `~/.omp/plugins`, then `omp plugin install https://github.com/namasme/just-my-pi --force` to sync omp's version record. `omp plugin upgrade just-my-pi` currently sees the cached GitHub commit as up to date. To test a local checkout before pushing it, use `omp plugin link /absolute/path/to/just-my-pi`.

## Contents

| Resource | Type | Notes |
|---|---|---|
| `report` | extension | Deterministic session reports. `/report` records the session as a Beads ticket with no LLM involved; `/triage-report` investigates eligible open tickets. Output goes to `~/pi/reports`, never into this repository |
| `heartbeat` | extension | On the main session, nudges the model to send a short status update if it has gone quiet (no user-facing text) for too long while still making tool calls. Threshold defaults to 10 minutes; override with `JUST_MY_PI_HEARTBEAT_SECONDS`. Also pins the agent's latest message above the editor (key `just-my-pi-status`) once a turn runs past 20s, with its age, tool-call count, and elapsed working time, so it stays visible through a long tool-call chain; disable with `JUST_MY_PI_STATUS_DISABLE=1`, or override the delay with `JUST_MY_PI_STATUS_DELAY_SECONDS` |
| `delegation` | extension | On the main session, nudges the model to delegate to a subagent as context fills, with a nudge probability set by how well the *current* model holds up at the *current* context size (a step curve over token ranges, not a single threshold; falls back to a generic fraction-of-context-window curve for unrecognized models). Disable with `JUST_MY_PI_DELEGATION_DISABLE=1`; force every eligible bucket to nudge (for smoke tests) with `JUST_MY_PI_DELEGATION_FORCE=1` |
| `cow-worktree` | skill | Creates APFS copy-on-write git worktrees, making branches of very large repositories cheap in time and disk. **macOS only** |
| `find-session` | skill | Hunt down a half-remembered pi/omp session by quoted fragments, topic, working-directory path, or timeframe. Scans both session stores (`~/.pi`, `~/.omp`), ranks candidates by how many clues they match, and returns the evidence trail — adjacent finds even on a miss. Requires `jq`; uses `rg` when present, falls back to `grep` |
| `schedule` | skill | Launchd-backed one-off, recurring, and conditional jobs with macOS notifications, retry state, cleanup, and automatic restoration. Use `/schedule` in pi or `/skill:schedule` in omp. macOS only; see [the skill](extensions/schedule/skills/schedule/SKILL.md) |

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

## schedule tests

```bash
cd extensions/schedule/skills/schedule
/usr/bin/python3 -m unittest -v test_schedule.py
```

These tests create isolated temporary LaunchAgents; they require a logged-in macOS GUI session and unload every test agent afterward.

## License

MIT

