"""Test-only fault-injection/adversarial hooks.

Every hook reads its `COW_WORKTREE_TEST_*` environment variable ONLY when
`plan.test_hooks_enabled` (or the equivalent `enabled` parameter) is True
-- i.e. only when the hidden, non-default `--enable-test-hooks` CLI flag
was explicitly passed (see cli.py). This is deliberately not
ambient-env-gated alone: a real invocation run without that flag ignores
every one of these variables completely, even if set in the ambient
environment (e.g. inherited by accident from a parent shell/CI job). Each
hook is exercised by exactly one test in tests/test_cow_worktree.py; the
ambient-env-without-the-flag case is covered by
TestTestHooksDisabledByDefault. None of this is reachable through any
other code path, and --enable-test-hooks is suppressed from --help -- this
is test infrastructure, not a supported end-user feature."""
from __future__ import annotations

import os
import shutil
from typing import Optional

from .models import Plan, SeedInfo


def _maybe_inject_symlink_attack(plan: Plan) -> None:
    """Simulates an attacker racing the reserved tmp_path before
    registration: removes the freshly created empty directory and
    replaces it with a symlink to an arbitrary existing path."""
    if not plan.test_hooks_enabled:
        return
    victim = os.environ.get("COW_WORKTREE_TEST_SYMLINK_ATTACK_TARGET")
    if not victim:
        return
    os.rmdir(plan.tmp_path)
    os.symlink(victim, plan.tmp_path)


def _maybe_inject_symlink_attack_post_marker(plan: Plan) -> None:
    """Simulates an attacker winning a *later* race than
    `_maybe_inject_symlink_attack`: by this point the reserved directory
    is no longer empty (it holds at least the worktree's `.git` pointer
    file), so `os.rmdir` alone can't apply; uses `shutil.rmtree` +
    `os.symlink` to simulate the result such a race would leave behind.
    Proves the identity re-checks placed before every later mutating step
    catch a race that happens after registration too, not just before."""
    if not plan.test_hooks_enabled:
        return
    victim = os.environ.get("COW_WORKTREE_TEST_SYMLINK_ATTACK_POST_MARKER_TARGET")
    if not victim:
        return
    shutil.rmtree(plan.tmp_path)
    os.symlink(victim, plan.tmp_path)


def _maybe_mutate_seed_for_test(seed: SeedInfo, stage: str, enabled: bool) -> None:
    """Mutates one tracked seed file's content while preserving its exact
    size and mtime (but not ctime, which an unprivileged process can't
    forge), to exercise verify_seed_unmodified()."""
    if not enabled:
        return
    rel = os.environ.get("COW_WORKTREE_TEST_MUTATE_SEED_PATH")
    if not rel or os.environ.get("COW_WORKTREE_TEST_MUTATE_SEED_STAGE") != stage:
        return
    target_path = os.path.join(seed.path, rel)
    st = os.stat(target_path)
    with open(target_path, "rb") as f:
        content = f.read()
    if not content:
        content = b"\x00"
    mutated = bytes([content[0] ^ 0xFF]) + content[1:]
    with open(target_path, "wb") as f:
        f.write(mutated)
    os.utime(target_path, ns=(st.st_atime_ns, st.st_mtime_ns))


def _maybe_create_dest_race_for_test(dest_abs: str, enabled: bool) -> None:
    """Simulates a concurrent process creating DEST between validate_dest()
    and the final move, to exercise move_worktree()'s re-check."""
    if not enabled:
        return
    if os.environ.get("COW_WORKTREE_TEST_CREATE_DEST_BEFORE_MOVE") == "1":
        os.makedirs(dest_abs, exist_ok=True)


def _maybe_create_dest_with_content_race_for_test(dest_abs: str, enabled: bool) -> None:
    """Simulates a concurrent process winning the genuine, narrower
    check-to-move TOCTOU race strictly inside move_worktree() itself,
    between its own `os.path.lexists` re-check and the `git worktree move`
    call (the coarser race, before move_worktree() is even called, is
    what `_maybe_create_dest_race_for_test` exercises instead). Creates
    DEST with real foreign file content, not just an empty directory, to
    prove that content -- not merely the directory's existence -- survives
    this narrowest race untouched."""
    if not enabled:
        return
    if os.environ.get("COW_WORKTREE_TEST_CREATE_DEST_WITH_CONTENT_DURING_MOVE") == "1":
        os.makedirs(dest_abs, exist_ok=True)
        with open(os.path.join(dest_abs, "foreign-marker.txt"), "w") as f:
            f.write("pre-existing foreign content that must survive\n")


def _test_fail_stage(plan: Plan) -> Optional[str]:
    """Inert unless test hooks are explicitly enabled; see the module
    docstring above."""
    if not plan.test_hooks_enabled:
        return None
    return os.environ.get("COW_WORKTREE_TEST_FAIL_STAGE")
