"""Reservation, registration, copy, transform, verification, move, and
cleanup of the temporary and final worktree. This is the core mutating
pipeline; see references/design.md's numbered "Algorithm" section for how
these steps fit together and why they're ordered this way."""
from __future__ import annotations

import os
import shutil
import stat
import uuid
from typing import Optional

from .clonefile import clonefile_path
from .errors import CowError
from .gitenv import git, git_common_dir, git_verify, literal_abspath, parse_worktree_list_porcelain
from .log import LOG
from .models import SeedInfo, TargetInfo
from .test_hooks import _maybe_create_dest_with_content_race_for_test

TMP_PREFIX = ".cow-wt-tmp."
MARKER_NAME = "COW_WRAPPER_MARKER"
SIDECAR_SUFFIX = ".cow-owner"


def reserve_tmp_path(dest_abs: str, token: str) -> tuple[str, str, int, int]:
    """Atomically reserve a brand-new directory *inode* (via `os.mkdir`,
    which can never silently claim a path a racing symlink already holds)
    before `git worktree add` ever runs, and record its exact
    (device, inode). Every later security-sensitive step re-verifies this
    identity via `verify_reservation_intact()` before doing anything
    destructive -- this is what closes the raced-symlink-to-a-victim-
    worktree attack.

    An `O_EXCL` sidecar recording the same token is kept as a second,
    independent, filename-based ownership proof, usable even in the
    narrow window before git's own private-gitdir marker exists.
    """
    parent = os.path.dirname(dest_abs) or "."
    for _ in range(20):
        candidate = os.path.join(parent, TMP_PREFIX + uuid.uuid4().hex[:16])
        sidecar = candidate + SIDECAR_SUFFIX
        if os.path.lexists(candidate) or os.path.lexists(sidecar):
            continue
        try:
            os.mkdir(candidate, 0o700)
        except FileExistsError:
            continue
        try:
            fd = os.open(sidecar, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            # Extremely unlikely (candidate and sidecar share the random
            # suffix), but undo the reservation and retry with a fresh
            # name rather than proceed without sidecar proof.
            os.rmdir(candidate)
            continue
        with os.fdopen(fd, "w") as f:
            f.write(token + "\n")
            f.flush()
            os.fsync(f.fileno())
        st = os.lstat(candidate)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            # Unreachable in practice (just created ourselves); treated as
            # a hard failure rather than silently continuing.
            raise CowError(
                f"reserved path is not a plain directory immediately after creation: {candidate}"
            )
        return candidate, sidecar, st.st_dev, st.st_ino
    raise CowError("could not reserve a unique temporary worktree path")


def verify_reservation_intact(path: str, expected_dev: int, expected_ino: int, context: str) -> None:
    """lstat-based identity check that MUST run before any registration
    lookup or destructive command touches `path`. Rejects a symlink, a
    non-directory, or a device/inode mismatch -- the exact raced
    symlink-to-a-victim-worktree attack this exists to close."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        raise CowError(f"wrapper-owned path vanished before {context}: {path}")
    if stat.S_ISLNK(st.st_mode):
        raise CowError(
            f"SECURITY: wrapper-owned path became a symlink before {context} "
            f"(possible race/attack), refusing to proceed: {path} -> {os.readlink(path)!r}"
        )
    if not stat.S_ISDIR(st.st_mode):
        raise CowError(f"wrapper-owned path is no longer a directory before {context}: {path}")
    if st.st_dev != expected_dev or st.st_ino != expected_ino:
        raise CowError(
            f"SECURITY: wrapper-owned path was replaced before {context} "
            f"(device/inode changed, possible race/attack): {path} "
            f"(expected dev={expected_dev} ino={expected_ino}, got dev={st.st_dev} ino={st.st_ino})"
        )


def add_worktree(seed: SeedInfo, tmp_path: str, target: TargetInfo) -> None:
    LOG.step(f"Registering temporary worktree: {tmp_path}")
    if target.branch_ref is not None:
        branch_name = target.branch_ref[len("refs/heads/") :]
        git(["worktree", "add", "--no-checkout", tmp_path, branch_name], cwd=seed.path)
    else:
        git(
            ["worktree", "add", "--no-checkout", "--detach", tmp_path, target.commit],
            cwd=seed.path,
        )
    # Closes the mutable-ref race between target resolution and worktree add.
    actual = git(["rev-parse", "HEAD"], cwd=tmp_path).stdout.decode().strip()
    if actual != target.commit:
        raise CowError(
            f"target moved during creation: resolved {target.commit}, worktree HEAD is {actual}"
        )


def capture_private_gitdir(tmp_path: str) -> str:
    """Capture git's own private-gitdir path exactly once, immediately
    after `git worktree add` succeeded -- the one moment this module still
    fully trusts cd-ing into `tmp_path`. Every later ownership/marker/
    registration check reads or writes this absolute path directly and
    never again re-derives anything by cd-ing into `tmp_path` or its
    eventual moved location."""
    return git(
        ["rev-parse", "--path-format=absolute", "--git-dir"], cwd=tmp_path
    ).stdout.decode().strip()


def write_marker(private_gitdir: str, token: str) -> None:
    """Mark the worktree's *private git dir* (not its working tree) as
    wrapper-owned, so cleanup never needs to guess from directory
    contents. Kept out of the working tree so it can never leak into
    DEST."""
    with open(os.path.join(private_gitdir, MARKER_NAME), "w") as f:
        f.write(token + "\n")


def is_marked_gitdir(private_gitdir: str, token: str) -> bool:
    try:
        with open(os.path.join(private_gitdir, MARKER_NAME)) as f:
            return f.read().strip() == token
    except OSError:
        return False


def remove_private_marker(private_gitdir: str, token: str) -> None:
    if not is_marked_gitdir(private_gitdir, token):
        raise CowError("wrapper private marker disappeared or changed before completion")
    os.unlink(os.path.join(private_gitdir, MARKER_NAME))


def read_private_gitdir_workdir(private_gitdir: str) -> Optional[str]:
    """Read git's own trusted `gitdir` pointer file inside the private
    admin directory (never by cd-ing into the untrusted working-tree
    path) for which working-tree path this registration currently points
    at (tmp_path before a move, DEST after)."""
    pointer = os.path.join(private_gitdir, "gitdir")
    try:
        with open(pointer) as f:
            content = f.read().strip()
    except OSError:
        return None
    suffix = os.sep + ".git"
    if content.endswith(suffix):
        return content[: -len(suffix)]
    return None


def registration_points_at(private_gitdir: str, expected_path: str) -> bool:
    workdir = read_private_gitdir_workdir(private_gitdir)
    if workdir is None:
        return False
    return literal_abspath(workdir) == literal_abspath(expected_path)


def init_index_to_seed(tmp_path: str, seed_tree: str) -> None:
    LOG.step("Initializing destination index to seed commit (S)")
    git(["read-tree", seed_tree], cwd=tmp_path)


def copy_tracked_files(seed: SeedInfo, tmp_path: str, test_hooks_enabled: bool = False) -> int:
    LOG.step("CoW-cloning seed's tracked files with clonefile(2)")
    paths = [p for p in git(["ls-files", "-z"], cwd=seed.path).stdout.split(b"\0") if p]
    seed_b = os.fsencode(seed.path)
    tmp_b = os.fsencode(tmp_path)
    # Test-only fault injection: inert unless test hooks were explicitly
    # enabled, so an ambient COW_WORKTREE_TEST_FAIL_AFTER_COPY alone can
    # never affect a production run.
    fail_after = os.environ.get("COW_WORKTREE_TEST_FAIL_AFTER_COPY") if test_hooks_enabled else None
    fail_after_n = int(fail_after) if fail_after is not None else None
    count = 0
    for rel in paths:
        if rel == b".git" or rel.startswith(b".git/"):
            raise CowError(f"refusing to copy a tracked path inside .git: {os.fsdecode(rel)!r}")
        src = os.path.join(seed_b, rel)
        dst = os.path.join(tmp_b, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        try:
            clonefile_path(src, dst)
        except OSError as e:
            raise CowError(
                f"clonefile failed for {os.fsdecode(rel)!r}: {e}; "
                "the destination must be on the same clonefile-capable APFS volume"
            ) from e
        count += 1
        if fail_after_n is not None and count >= fail_after_n:
            raise CowError(f"injected test failure after {count} cloned files")
    LOG.info(f"cloned {count} tracked file(s)")
    return count


def refresh_index(tmp_path: str) -> None:
    LOG.step("Refreshing and validating index stat cache after CoW copy")
    # Mandatory: read-tree left zeroed stat data. A checked refresh both
    # initializes it and rejects any seed drift copied into the temp
    # worktree before the S -> T transform (git_verify(): see gitenv.py).
    git_verify(["update-index", "--refresh"], cwd=tmp_path)


def transform_tree(tmp_path: str, seed_tree: str, target_tree: str) -> None:
    LOG.step("Transforming tree S -> T with `git read-tree -m -u`")
    git(["read-tree", "-m", "-u", seed_tree, target_tree], cwd=tmp_path)


def verify_worktree(
    tmp_path: str,
    expected_commit: str,
    expected_tree: str,
    expected_branch_ref: Optional[str],
    expected_common_dir: str,
) -> None:
    LOG.step("Verifying resulting worktree")

    head = git(["rev-parse", "HEAD"], cwd=tmp_path).stdout.decode().strip()
    if head != expected_commit:
        raise CowError(f"HEAD mismatch after transform: got {head}, expected {expected_commit}")

    index_tree = git(["write-tree"], cwd=tmp_path).stdout.decode().strip()
    if index_tree != expected_tree:
        raise CowError(
            f"index tree mismatch after transform: got {index_tree}, expected {expected_tree}"
        )

    proc = git(["symbolic-ref", "-q", "HEAD"], cwd=tmp_path, check=False)
    branch_ref = proc.stdout.decode().strip() or None if proc.returncode == 0 else None
    if branch_ref != expected_branch_ref:
        raise CowError(f"branch mismatch: got {branch_ref!r}, expected {expected_branch_ref!r}")

    common_dir = git_common_dir(tmp_path)
    if common_dir != expected_common_dir:
        raise CowError(
            f"common git dir mismatch: got {common_dir!r}, expected {expected_common_dir!r}"
        )

    status = git_verify(["status", "--porcelain", "--ignored"], cwd=tmp_path).stdout.decode(
        errors="replace"
    )
    if status.strip():
        raise CowError(f"worktree not clean after transform:\n{status}")

    LOG.info("HEAD, index tree, branch, common dir, and clean status all verified OK")


def verify_seed_unmodified(seed: SeedInfo, when: str) -> None:
    """Re-verify SEED's tracked files (worktree and index) still exactly
    match its recorded HEAD, and that HEAD itself hasn't moved. Called
    before/after the CoW copy and before/after the final move, closing
    the window between validate_seed() and each later mutating step.
    Note: a mutation preserving content size, mtime, AND ctime would not
    be caught -- but ctime can't be forged without controlling the system
    clock, so this closes the realistic version of that race (see
    references/design.md, "Limitations")."""
    LOG.step(f"Re-verifying seed is unmodified ({when})")
    proc = git_verify(["diff", "--quiet", "--no-ext-diff", "HEAD", "--"], cwd=seed.path, check=False)
    if proc.returncode != 0:
        raise CowError(
            f"seed's tracked files no longer match HEAD ({when}); the seed was mutated "
            "during this run -- refusing to continue or move into place"
        )
    proc2 = git_verify(
        ["diff", "--quiet", "--no-ext-diff", "--cached", "HEAD", "--"], cwd=seed.path, check=False
    )
    if proc2.returncode != 0:
        raise CowError(
            f"seed's index no longer matches HEAD ({when}); the seed was mutated during this run"
        )
    actual_head = git(["rev-parse", "HEAD"], cwd=seed.path).stdout.decode().strip()
    if actual_head != seed.head_commit:
        raise CowError(
            f"seed's HEAD moved during this run ({when}): "
            f"expected {seed.head_commit}, got {actual_head}"
        )


def move_worktree(
    seed: SeedInfo,
    tmp_path: str,
    dest_abs: str,
    private_gitdir: str,
    test_hooks_enabled: bool = False,
) -> None:
    LOG.step(f"Moving worktree into place: {dest_abs}")
    # `git worktree move` treats an *existing* destination as a place to
    # move INTO, not an error: for an empty dir it silently succeeds via a
    # rename-style move, and for a non-empty one it nests the worktree one
    # level deeper (DEST/<tmp-name>/...) without any error. Never invoke
    # it unless DEST has just been re-confirmed absent in any form.
    if os.path.lexists(dest_abs):
        raise CowError(
            f"destination came into existence before the final move (concurrent creation?): "
            f"{dest_abs}; refusing to move -- this wrapper never removes, empties, or moves "
            "into an existing destination"
        )

    # Bounded, non-eliminated race (see references/design.md, "Second
    # critic review" #4): the window between the lexists check above and
    # the `git worktree move` call below can't be made atomic from Python
    # without a kernel primitive `git worktree move` doesn't expose. This
    # is a detect-and-fail-safe, not an eliminate: the private-gitdir
    # re-check below turns a race that wins here into a clean, reported
    # failure with any foreign content provably preserved, never data
    # loss. Closing it outright requires DEST's parent directory to be
    # private (not concurrently writable) for the run's duration.
    _maybe_create_dest_with_content_race_for_test(dest_abs, test_hooks_enabled)

    git(["worktree", "move", tmp_path, dest_abs], cwd=seed.path)
    if os.path.islink(dest_abs) or not os.path.isdir(dest_abs):
        raise CowError(
            f"worktree move did not produce the expected destination directory: {dest_abs}"
        )

    # Explicit re-check via git's own trusted registration record: confirm
    # it points at DEST exactly, not a subdirectory of it. If the race
    # above was hit, `git worktree move` can exit 0 while nesting the
    # worktree one level deeper instead of DEST becoming the worktree
    # itself -- detect that here as a clear, attributable error rather
    # than a confusing downstream one.
    recorded = read_private_gitdir_workdir(private_gitdir)
    if recorded is None or literal_abspath(recorded) != literal_abspath(dest_abs):
        raise CowError(
            "destination was raced into existence during the final move (foreign content at "
            f"{dest_abs!r} caused the worktree to nest inside it at {recorded!r} instead of "
            "becoming DEST itself); this is a bounded, non-destructive, detect-and-fail-safe "
            "race, not a data-loss one -- the foreign content at DEST is left completely "
            "untouched, and cleanup removes only the nested worktree this run created; a real "
            "pilot must use a private (not concurrently writable) parent directory for DEST "
            "to eliminate this window entirely -- see README's Limitations"
        )


def sidecar_matches(sidecar_path: str, token: str) -> bool:
    try:
        with open(sidecar_path) as f:
            return f.read().strip() == token
    except OSError:
        return False


def registered_at(seed: SeedInfo, path: str) -> bool:
    """Literal (non-symlink-resolving) match against `git worktree list`.
    Used only for a post-cleanup stale-registration sanity check;
    ownership decisions during cleanup rely on
    private_gitdir/registration_points_at, never on this alone."""
    entries = parse_worktree_list_porcelain(
        git(["worktree", "list", "--porcelain"], cwd=seed.path).stdout.decode(errors="replace")
    )
    wanted = literal_abspath(path)
    return any(literal_abspath(e.get("worktree", "")) == wanted for e in entries if e.get("worktree"))


def cleanup_owned(
    seed: SeedInfo,
    worktree_path: str,
    sidecar_path: str,
    token: str,
    private_gitdir: str,
    expected_dev: int,
    expected_ino: int,
) -> None:
    """Remove only a path this exact invocation can positively prove it
    owns. Ownership proof never trusts `worktree_path` alone, since it
    might have been raced/replaced:

      * the O_EXCL sidecar token must match;
      * before touching the filesystem at all, an lstat identity check
        (device+inode from reservation time) must pass -- a symlink,
        non-directory, or different inode means cleanup refuses outright
        and does nothing else, closing the raced-symlink-to-a-victim-
        worktree attack;
      * `private_gitdir` (captured once, directly from `worktree add`'s
        own output, never re-derived via `worktree_path`) is git's own
        trusted administrative record; its marker/`gitdir` pointer files
        are read directly. `git worktree remove --force` only runs once
        one of these two proves this exact registration is ours.
    """
    if not worktree_path or not sidecar_matches(sidecar_path, token):
        LOG.warn("refusing cleanup: wrapper ownership sidecar missing/mismatched")
        return
    if literal_abspath(worktree_path) == literal_abspath(seed.path):
        LOG.warn("refusing cleanup: worktree path resolves to seed")
        return
    if not os.path.basename(os.path.splitext(sidecar_path)[0]).startswith(TMP_PREFIX):
        LOG.warn(f"refusing cleanup: unexpected sidecar name {sidecar_path}")
        return

    st = None
    try:
        st = os.lstat(worktree_path)
    except FileNotFoundError:
        pass
    except OSError as e:
        LOG.warn(f"refusing cleanup: could not lstat {worktree_path}: {e}")
        return

    identity_ok = False
    if st is not None:
        if stat.S_ISLNK(st.st_mode):
            LOG.warn(
                "SECURITY: refusing cleanup -- wrapper-owned path is now a symlink "
                f"(possible race/attack); leaving it and its target untouched: "
                f"{worktree_path} -> {os.readlink(worktree_path)!r}"
            )
            return
        if not stat.S_ISDIR(st.st_mode):
            LOG.warn(f"refusing cleanup: wrapper-owned path is no longer a directory: {worktree_path}")
            return
        if (st.st_dev, st.st_ino) != (expected_dev, expected_ino):
            LOG.warn(
                "SECURITY: refusing cleanup -- wrapper-owned path device/inode changed "
                f"(possible race/attack); leaving it untouched: {worktree_path} "
                f"(expected dev={expected_dev} ino={expected_ino}, "
                f"got dev={st.st_dev} ino={st.st_ino})"
            )
            return
        identity_ok = True

    if private_gitdir and os.path.isdir(private_gitdir):
        marker_ok = is_marked_gitdir(private_gitdir, token)
        points_at_us = identity_ok and registration_points_at(private_gitdir, worktree_path)
        if not (marker_ok or points_at_us):
            LOG.warn(
                "refusing `git worktree remove`: ownership not proven for this registration "
                f"(private_gitdir={private_gitdir!r}, path={worktree_path!r}); leaving "
                "everything untouched"
            )
            return
        LOG.step(f"Cleaning up wrapper-owned worktree registration: {worktree_path}")
        proc = git(["worktree", "remove", "--force", worktree_path], cwd=seed.path, check=False)
        if proc.returncode != 0:
            LOG.warn(
                f"`git worktree remove --force` failed (rc={proc.returncode}): "
                f"{proc.stderr.decode(errors='replace').strip()}"
            )
        if os.path.isdir(private_gitdir) or registered_at(seed, worktree_path):
            LOG.warn(
                f"stale worktree registration remains after cleanup attempt "
                f"(path={worktree_path!r}, private_gitdir={private_gitdir!r}); leaving the "
                "filesystem path untouched for manual inspection"
            )
            return

    # Filesystem cleanup of our own reserved directory, only after any
    # registration has been proven-cleaned or never existed. Re-check
    # identity once more immediately before removal (defense in depth
    # against a race between the checks above and this call).
    if os.path.lexists(worktree_path):
        try:
            st2 = os.lstat(worktree_path)
        except FileNotFoundError:
            st2 = None
        if st2 is not None:
            if stat.S_ISLNK(st2.st_mode):
                LOG.warn(f"refusing cleanup of unexpected symlink: {worktree_path}")
            elif not stat.S_ISDIR(st2.st_mode):
                LOG.warn(f"refusing cleanup of unexpected non-directory: {worktree_path}")
            elif (st2.st_dev, st2.st_ino) != (expected_dev, expected_ino):
                LOG.warn(
                    f"SECURITY: refusing final removal -- identity changed again: {worktree_path}"
                )
            else:
                try:
                    shutil.rmtree(worktree_path)
                except OSError as e:
                    LOG.warn(f"failed to remove wrapper path {worktree_path}: {e}")
    try:
        os.unlink(sidecar_path)
    except FileNotFoundError:
        pass
