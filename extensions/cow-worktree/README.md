# pi-cow-worktree

A user-invoked Pi skill for creating APFS copy-on-write Git worktrees.

The package keeps the worktree creator, its safety notes, and its synthetic test suite together. It has no runtime dependencies beyond macOS, APFS, Git, and Python 3.9 or newer.

## Install

This skill ships inside the `just-my-pi` package:

```bash
pi install git:git@github.com:namasme/just-my-pi@v0.1.0
```

Reload a running Pi session afterwards:

```text
/reload
```

## Use

```text
/skill:cow-worktree <target or PR URL> <destination name or path>
```

Example:

```text
/skill:cow-worktree https://github.com/example-org/example-repo/pull/1234 review-pr-1234
```

`--seed` is required and has no default: pass the path to a clean, full, non-sparse worktree to clone from.

## Test

```bash
cd skills/cow-worktree
python3 -m py_compile bin/cow_worktree.py bin/cow_worktree_core/*.py tests/*.py bench/benchmark.py
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

The cross-device tests skip when their disposable APFS disk-image fixture is absent.
