# pi-extensions

Personal [pi](https://pi.dev) package: extensions, skills, and subagent definitions.

## Install

```bash
pi install git:github.com/namasme/pi-extensions@v0.1.0
```

Or reference it from `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/namasme/pi-extensions@v0.1.0"]
}
```

## Contents

| Resource | Type | Notes |
|---|---|---|
| `require-bash-timeout` | extension | Rejects `bash` tool calls that omit an explicit timeout, so no agent command can hang indefinitely |
| `cow-worktree` | skill | Creates APFS copy-on-write git worktrees, making branches of very large repositories cheap in time and disk. **macOS only** |
| `critic`, `investigator`, `planner`, `worker` | subagents | Role definitions for [`pi-subagents`](https://github.com/nicobailon/pi-subagents) |

## Selective loading

Load only part of the package with settings-level filtering. For example, on Linux, where the APFS-based skill cannot work:

```json
{
  "packages": [
    {
      "source": "git:github.com/namasme/pi-extensions@v0.1.0",
      "skills": []
    }
  ]
}
```

## Subagent models

The agent definitions pin ordinary provider models (`anthropic/…`, `openai/…`). To route them through a different provider or gateway, override locally rather than editing the files:

```json
{
  "subagents": {
    "agentOverrides": {
      "investigator": { "model": "your-provider/your-model" }
    }
  }
}
```

## cow-worktree tests

```bash
cd extensions/cow-worktree/skills/cow-worktree
python3 -m pytest tests/
```

Tests only ever operate inside their own lab directory; `tests/helpers.py` resolves every path with `realpath()` and refuses anything outside it.

## License

MIT
