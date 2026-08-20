# pi-cow-worktree

A user-invoked Pi skill for creating APFS copy-on-write Git worktrees.

The package keeps the worktree creator, its safety notes, and its synthetic test suite together. It has no runtime dependencies beyond macOS, APFS, Git, and Python 3.9 or newer.

## Install

```bash
pi install ~/pi/extensions/cow-worktree
```

Reload a running Pi session after installation:

```text
/reload
```

## Use

```text
/skill:cow-worktree <target or PR URL> <destination name or path>
```

Example:

```text
/skill:cow-worktree https://github.com/example-org/monorepo/pull/1234 review-pr-1234
```

The default the monorepo seed is `~/src/pristine-monorepo`. Pass a different seed explicitly when needed.

## Test

```bash
cd skills/cow-worktree
python3 -m py_compile bin/cow_worktree.py tests/*.py bench/benchmark.py
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

The cross-device tests skip when their disposable APFS disk-image fixture is absent.
