# just-my-pi

Personal [pi](https://pi.dev) package: extensions and skills.

## Install

The repository is public, so the HTTPS form needs no SSH agent or credentials.

```bash
pi install git:github.com/namasme/just-my-pi@v0.3.0
```

Or reference it from `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/namasme/just-my-pi@v0.3.0"]
}
```

## Contents

| Resource | Type | Notes |
|---|---|---|
| `require-bash-timeout` | extension | Rejects `bash` tool calls that omit an explicit timeout, so no agent command can hang indefinitely |
| `report` | extension | Deterministic session reports. `/report` records the session as a Beads ticket with no LLM involved; `/triage-report` investigates eligible open tickets. Output goes to `~/pi/reports`, never into this repository |
| `cow-worktree` | skill | Creates APFS copy-on-write git worktrees, making branches of very large repositories cheap in time and disk. **macOS only** |

## Selective loading

Load only part of the package with settings-level filtering. For example, on Linux, where the APFS-based skill cannot work:

```json
{
  "packages": [
    {
      "source": "git:github.com/namasme/just-my-pi@v0.3.0",
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

