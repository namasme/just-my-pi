"""Seed/target/destination validation, run before anything is mutated."""
from __future__ import annotations

import os

from .errors import CowError
from .gitenv import abspath, git, git_common_dir, git_verify, parse_worktree_list_porcelain
from .log import LOG
from .models import SeedInfo, TargetInfo


def check_no_gitlinks_in_tree(cwd: str, tree: str, label: str) -> None:
    """Recursively scan `tree` for mode-160000 (submodule/gitlink) entries
    at any depth and reject if any are found. Applied to both the seed's
    HEAD tree and the target's tree: a target that merely introduces a
    gitlink must be rejected as surely as a seed that already has one,
    and before any mutation happens."""
    proc = git(["ls-tree", "-r", "-z", tree], cwd=cwd)
    gitlinks = []
    for record in (r for r in proc.stdout.split(b"\0") if r):
        meta, _, path = record.partition(b"\t")
        parts = meta.split(b" ")
        mode = parts[0] if parts else b""
        if mode == b"160000":
            gitlinks.append(os.fsdecode(path))
    if gitlinks:
        sample = ", ".join(repr(p) for p in gitlinks[:10])
        raise CowError(f"{label} contains unsupported submodule/gitlink paths: {sample}")


def validate_seed(seed_path: str) -> SeedInfo:
    LOG.step(f"Validating seed worktree: {seed_path}")

    if not os.path.isdir(seed_path):
        raise CowError(f"seed path does not exist or is not a directory: {seed_path}")

    proc = git(["rev-parse", "--is-inside-work-tree"], cwd=seed_path, check=False)
    if proc.returncode != 0 or proc.stdout.decode().strip() != "true":
        raise CowError(f"seed is not inside a git work tree: {seed_path}")

    proc = git(["rev-parse", "--is-bare-repository"], cwd=seed_path)
    if proc.stdout.decode().strip() == "true":
        raise CowError("seed resolves to a bare repository; a worktree is required")

    toplevel = abspath(
        git(["rev-parse", "--show-toplevel"], cwd=seed_path).stdout.decode().strip()
    )
    if toplevel != abspath(seed_path):
        raise CowError(
            f"seed path is not the top level of its worktree "
            f"(seed={seed_path!r}, toplevel={toplevel!r}); pass the worktree root"
        )

    common_dir = git_common_dir(seed_path)

    proc = git(["rev-parse", "--verify", "HEAD"], cwd=seed_path, check=False)
    if proc.returncode != 0:
        raise CowError("seed has no commits (HEAD does not resolve); nothing to seed from")
    head_commit = proc.stdout.decode().strip()
    head_tree = git(["rev-parse", "HEAD^{tree}"], cwd=seed_path).stdout.decode().strip()

    proc = git(["sparse-checkout", "list"], cwd=seed_path, check=False)
    if proc.returncode == 0:
        raise CowError(
            "seed is a sparse checkout (git sparse-checkout is enabled); "
            "sparse seeds are rejected"
        )

    # git_verify(): forces fsmonitor/trustctime/checkStat so ambient config
    # can't make a dirty seed look falsely clean (see gitenv.py).
    proc = git_verify(["diff", "--quiet", "--no-ext-diff", "HEAD", "--"], cwd=seed_path, check=False)
    if proc.returncode != 0:
        raise CowError(
            "seed's tracked files do not exactly match HEAD "
            "(staged and/or unstaged changes present); refusing to seed from a dirty worktree"
        )

    proc = git_verify(["status", "--porcelain", "--ignored"], cwd=seed_path)
    dirty_lines = proc.stdout.decode(errors="replace").splitlines()
    if dirty_lines:
        sample = "\n".join(f"      {l}" for l in dirty_lines[:20])
        raise CowError(
            "seed contains untracked and/or ignored files; refusing to seed "
            f"(reject all seed untracked/ignored content):\n{sample}"
        )

    # Gitlinks/submodules need recursive worktree semantics this wrapper
    # deliberately does not implement; scanned via the tree (equivalent to
    # the index, already proven clean above) so it shares code with the
    # target-side check in resolve_target().
    check_no_gitlinks_in_tree(seed_path, head_tree, "seed")

    proc = git(["symbolic-ref", "-q", "HEAD"], cwd=seed_path, check=False)
    branch_ref = proc.stdout.decode().strip() or None if proc.returncode == 0 else None

    LOG.info(f"seed HEAD commit  = {head_commit}")
    LOG.info(f"seed HEAD tree    = {head_tree}")
    LOG.info(f"seed branch       = {branch_ref or '(detached)'}")
    LOG.info(f"seed common dir   = {common_dir}")

    return SeedInfo(
        path=abspath(seed_path),
        common_dir=common_dir,
        head_commit=head_commit,
        head_tree=head_tree,
        branch_ref=branch_ref,
    )


def resolve_target(seed: SeedInfo, target: str) -> TargetInfo:
    LOG.step(f"Resolving target: {target!r}")

    proc = git(["rev-parse", "--verify", f"{target}^{{commit}}"], cwd=seed.path, check=False)
    if proc.returncode != 0:
        raise CowError(
            f"target {target!r} does not resolve to a commit within seed's repository "
            f"({seed.common_dir})"
        )
    commit = proc.stdout.decode().strip()
    tree = git(["rev-parse", f"{commit}^{{tree}}"], cwd=seed.path).stdout.decode().strip()

    # Must run before any mutation: a target-introduced gitlink is rejected
    # just as surely as a seed that already has one (see docstring above).
    check_no_gitlinks_in_tree(seed.path, tree, "target")

    proc = git(["rev-parse", "--symbolic-full-name", target], cwd=seed.path, check=False)
    sym = proc.stdout.decode().strip() if proc.returncode == 0 else ""
    branch_ref = sym if sym.startswith("refs/heads/") else None

    LOG.info(f"target commit = {commit}")
    LOG.info(f"target tree   = {tree}")
    LOG.info(f"target branch = {branch_ref or '(detached commit)'}")

    if branch_ref is not None:
        check_branch_not_checked_out_elsewhere(seed, branch_ref)

    return TargetInfo(commit=commit, tree=tree, branch_ref=branch_ref)


def check_branch_not_checked_out_elsewhere(seed: SeedInfo, branch_ref: str) -> None:
    proc = git(["worktree", "list", "--porcelain"], cwd=seed.path)
    entries = parse_worktree_list_porcelain(proc.stdout.decode(errors="replace"))
    for e in entries:
        if e.get("branch") == branch_ref:
            raise CowError(
                f"target branch {branch_ref!r} is already checked out in worktree "
                f"{e.get('worktree')!r}; refusing (branches can only be checked out once)"
            )


def validate_dest(seed: SeedInfo, dest: str) -> str:
    LOG.step(f"Validating destination: {dest}")
    expanded = os.path.expanduser(dest)
    dest_abs = (
        expanded
        if os.path.isabs(expanded)
        else os.path.join(os.path.dirname(seed.path), expanded)
    )
    dest_abs = os.path.normpath(dest_abs)
    if not os.path.isabs(expanded):
        LOG.info(f"relative destination resolved beside seed: {dest_abs}")

    # Policy: DEST must not exist at all, not even as an empty directory.
    # `git worktree move` treats an *existing* directory as a place to
    # move INTO rather than erroring, so tolerating a pre-existing empty
    # directory would require this wrapper to remove it immediately
    # before the move -- reintroducing the exact TOCTOU this policy
    # exists to eliminate. See move_worktree() in worktree_ops.py.
    if os.path.lexists(dest_abs):
        raise CowError(
            f"destination already exists: {dest_abs}; it must not exist yet, not even as "
            "an empty directory -- this wrapper never removes, empties, or reuses an "
            "existing destination path"
        )

    parent = os.path.dirname(dest_abs) or "."
    if not os.path.isdir(parent):
        raise CowError(
            f"destination's parent directory does not exist: {parent} "
            "(create it first; the wrapper will not create ancestor directories)"
        )
    LOG.info("destination does not exist yet; parent directory exists: OK")
    return dest_abs


def validate_same_device(seed: SeedInfo, dest_abs: str, clonefile_available: bool) -> None:
    if not clonefile_available:
        raise CowError("clonefile(2) is unavailable; this wrapper requires macOS/APFS")
    seed_dev = os.stat(seed.path).st_dev
    ref_dir = os.path.dirname(dest_abs) or "."
    dest_dev = os.stat(ref_dir).st_dev
    if seed_dev != dest_dev:
        raise CowError(
            "destination is on a different filesystem/device than seed "
            f"(seed dev={seed_dev}, dest dev={dest_dev}); "
            "APFS `cp -c` clones and `git worktree move` both require the same device"
        )
    LOG.info(f"seed and destination share device id {seed_dev}: OK")
