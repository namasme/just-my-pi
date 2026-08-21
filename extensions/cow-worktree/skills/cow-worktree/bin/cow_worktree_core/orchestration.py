"""Plan construction and the mutating execution pipeline. See
references/design.md's numbered "Algorithm" section for the full
step-by-step rationale behind this exact ordering."""
from __future__ import annotations

import os

from .clonefile import CLONEFILE_AVAILABLE
from .errors import CowError
from .gitenv import git
from .log import LOG
from .models import Plan
from .partial_clone import describe_target_blob_status_readonly, materialize_target_objects
from .test_hooks import (
    _maybe_create_dest_race_for_test,
    _maybe_inject_symlink_attack,
    _maybe_inject_symlink_attack_post_marker,
    _maybe_mutate_seed_for_test,
    _test_fail_stage,
)
from .validation import resolve_target, validate_dest, validate_same_device, validate_seed
from .worktree_ops import (
    add_worktree,
    capture_private_gitdir,
    cleanup_owned,
    copy_tracked_files,
    init_index_to_seed,
    move_worktree,
    read_private_gitdir_workdir,
    refresh_index,
    remove_private_marker,
    reserve_tmp_path,
    transform_tree,
    verify_reservation_intact,
    verify_seed_unmodified,
    verify_worktree,
    write_marker,
)


def build_plan(seed_path: str, target: str, dest: str, enable_test_hooks: bool = False) -> Plan:
    seed = validate_seed(seed_path)
    target_info = resolve_target(seed, target)
    dest_abs = validate_dest(seed, dest)
    validate_same_device(seed, dest_abs, CLONEFILE_AVAILABLE)
    return Plan(
        seed=seed, target=target_info, dest=dest_abs, test_hooks_enabled=enable_test_hooks
    )


def print_plan(plan: Plan) -> None:
    LOG.step("Plan (dry run; no changes will be made)")
    LOG.info(f"seed             = {plan.seed.path}")
    LOG.info(f"seed HEAD        = {plan.seed.head_commit}")
    LOG.info(f"target commit    = {plan.target.commit}")
    LOG.info(f"target branch    = {plan.target.branch_ref or '(detached)'}")
    LOG.info(f"destination      = {plan.dest}")
    describe_target_blob_status_readonly(plan.seed, plan.target)
    proc = git(["diff", "--stat", plan.seed.head_commit, plan.target.commit], cwd=plan.seed.path)
    diffstat = proc.stdout.decode(errors="replace").strip()
    if diffstat:
        LOG.info("changes S -> T:")
        for line in diffstat.splitlines():
            LOG.info("  " + line)
    else:
        LOG.info("changes S -> T: none (seed and target are identical)")


def execute_plan(plan: Plan) -> None:
    seed, target = plan.seed, plan.target

    # Network preflight, strictly before anything is created/registered.
    materialize_target_objects(seed, target)

    plan.tmp_path, plan.sidecar_path, plan.tmp_dev, plan.tmp_ino = reserve_tmp_path(
        plan.dest, plan.marker_token
    )
    current_path = plan.tmp_path
    try:
        verify_reservation_intact(plan.tmp_path, plan.tmp_dev, plan.tmp_ino, "worktree add")
        _maybe_inject_symlink_attack(plan)
        verify_reservation_intact(
            plan.tmp_path, plan.tmp_dev, plan.tmp_ino, "worktree add (post-hook check)"
        )

        add_worktree(seed, plan.tmp_path, target)
        verify_reservation_intact(
            plan.tmp_path, plan.tmp_dev, plan.tmp_ino, "private-gitdir capture"
        )
        plan.private_gitdir = capture_private_gitdir(plan.tmp_path)

        if _test_fail_stage(plan) == "after-add-before-marker":
            raise CowError("injected test failure after worktree add, before marker")
        verify_reservation_intact(
            plan.tmp_path, plan.tmp_dev, plan.tmp_ino, "private marker write"
        )
        write_marker(plan.private_gitdir, plan.marker_token)
        if _test_fail_stage(plan) == "interrupt-after-marker":
            raise KeyboardInterrupt

        # Simulated post-registration race (test-only): proves the
        # identity re-check immediately below catches a race that wins
        # *after* registration/marker creation, not just before it.
        _maybe_inject_symlink_attack_post_marker(plan)
        verify_reservation_intact(
            plan.tmp_path, plan.tmp_dev, plan.tmp_ino, "index initialization"
        )
        init_index_to_seed(plan.tmp_path, seed.head_tree)

        _maybe_mutate_seed_for_test(seed, "before-copy", plan.test_hooks_enabled)
        verify_seed_unmodified(seed, "before copying tracked files")
        verify_reservation_intact(plan.tmp_path, plan.tmp_dev, plan.tmp_ino, "clone copy")
        copy_tracked_files(seed, plan.tmp_path, plan.test_hooks_enabled)
        verify_reservation_intact(plan.tmp_path, plan.tmp_dev, plan.tmp_ino, "index refresh")
        refresh_index(plan.tmp_path)
        verify_reservation_intact(plan.tmp_path, plan.tmp_dev, plan.tmp_ino, "read-tree transform")
        transform_tree(plan.tmp_path, seed.head_tree, target.tree)
        verify_reservation_intact(plan.tmp_path, plan.tmp_dev, plan.tmp_ino, "worktree verification")
        verify_worktree(
            plan.tmp_path,
            target.commit,
            target.tree,
            target.branch_ref,
            seed.common_dir,
        )

        _maybe_mutate_seed_for_test(seed, "before-move", plan.test_hooks_enabled)
        verify_seed_unmodified(seed, "before moving worktree into place")
        verify_reservation_intact(plan.tmp_path, plan.tmp_dev, plan.tmp_ino, "worktree move")
        _maybe_create_dest_race_for_test(plan.dest, plan.test_hooks_enabled)
        move_worktree(
            seed, plan.tmp_path, plan.dest, plan.private_gitdir, plan.test_hooks_enabled
        )
        if _test_fail_stage(plan) == "after-move-before-current":
            raise CowError("injected test failure after worktree move")
        current_path = plan.dest

        # Re-verify from the final path too (paranoia).
        verify_worktree(
            plan.dest,
            target.commit,
            target.tree,
            target.branch_ref,
            seed.common_dir,
        )
        verify_seed_unmodified(seed, "after moving worktree into place")

        remove_private_marker(plan.private_gitdir, plan.marker_token)
        os.unlink(plan.sidecar_path)
        LOG.step(f"Done: {plan.dest} is ready at {target.commit}")
    except BaseException:
        LOG.warn("failure detected; cleaning up wrapper-owned worktree only")
        # Git's own trusted per-worktree record (never derived by cd-ing
        # into the untrusted worktree_path) tells us the true current
        # registered path, whether that's still tmp_path or already the
        # moved DEST -- covers the race where git already moved things
        # but this process hasn't updated current_path yet.
        if plan.private_gitdir:
            recorded = read_private_gitdir_workdir(plan.private_gitdir)
            if recorded is not None:
                current_path = recorded
        cleanup_owned(
            seed,
            current_path,
            plan.sidecar_path,
            plan.marker_token,
            plan.private_gitdir,
            plan.tmp_dev,
            plan.tmp_ino,
        )
        raise
