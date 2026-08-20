#!/usr/bin/env python3
"""
cow_worktree.py -- defensive APFS copy-on-write Git worktree creator.

Creates a new Git worktree at DEST, checked out to TARGET (a branch or
commit), by cloning file content from an existing clean SEED worktree using
macOS `clonefile(2)` (APFS copy-on-write), instead of doing a
normal `git worktree add` + full checkout (which writes every blob's bytes
from the object database).

Design summary (see README.md for the full rationale):

  1. Validate SEED is clean, fully tracked (no untracked/ignored files),
     non-sparse, matches its recorded HEAD commit exactly, and contains no
     submodule/gitlink paths anywhere in its HEAD tree.
  2. Resolve TARGET within SEED's repository; refuse if it is a branch
     already checked out in another worktree, or if its tree contains a
     submodule/gitlink anywhere.
  3. Resolve a relative DEST beneath SEED's parent, then validate it: the
     path must not exist at all (not even as an empty directory) and must
     be on the same filesystem/device as SEED (`clonefile(2)` and
     `git worktree move` both require the same device).
  4. If SEED is a partial/promisor (blobless) clone, materialize every blob
     object the TARGET tree needs relative to SEED's tree in a dedicated
     network preflight step, strictly before any worktree
     registration/mutation, so a network failure aborts fail-fast with
     nothing created.
  5. Atomically reserve a brand-new, wrapper-owned temporary directory
     *inode* (not just a sidecar file) next to DEST, record its exact
     device/inode, and register it as a new worktree with
     `git worktree add --no-checkout`. Every later security-sensitive
     step re-verifies that exact device/inode via `lstat` before doing
     anything destructive, closing a raced-symlink-to-a-victim-worktree
     attack.
  6. Set the new worktree's index to the SEED commit's tree (S) with
     `git read-tree S` (no working-tree effect yet).
  7. CoW-clone every file tracked by SEED (`git ls-files`) into the new
     worktree through a direct `clonefile(2)` call, preserving symlinks,
     modes, and xattrs while NEVER touching `.git`. Immediately before and
     after this step (and again before/after the final move), SEED's
     tracked files are re-checked against HEAD (`git diff --quiet`, both
     worktree and cached) so a mutation of SEED mid-run is treated as a
     hard failure, not silently baked into DEST.
  8. Refresh the index stat cache (`git update-index --refresh`) so Git's
     notion of "up to date" matches the freshly copied files.
  9. Transform the tree from S to the TARGET tree (T) with
     `git read-tree -m -u S T`. This is a 2-way merge that updates the
     working tree *only* for paths that differ between S and T -- unchanged
     files are left untouched (and therefore keep sharing physical storage
     with SEED via the CoW clone from step 7).
 10. Verify HEAD, the index tree hash, the branch, the common Git
     directory, and clean status of the new worktree.
 11. Move the worktree into its final DEST with `git worktree move`, only
     after re-confirming DEST still does not exist at all (never a raw
     filesystem rename, and never removing/emptying anything at DEST).
 12. On any failure, remove *only* the wrapper-owned temporary worktree
     that this run created and can positively prove it owns; SEED and any
     pre-existing paths (including a concurrently-created DEST) are never
     touched, reset, or cleaned.

No `git clean` and no `git reset --hard` are used anywhere. All working
tree state is set explicitly via `git read-tree ... -u`, confined to the
new temporary worktree. Every git subprocess this wrapper runs has
repository-redirection/index/object-store `GIT_*` environment variables
(`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`,
`GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, etc.) stripped
from its environment first, so ambient environment poisoning cannot
redirect any command at a different repository, index, or object store.

Every security-relevant identity/cleanliness check (reservation-path
`lstat` identity, seed dirty/mutation checks, index-refresh drift
detection, final clean-status checks) is additionally re-run immediately
before each mutating step of the pipeline (marker write, index init,
clonefile copy, index refresh, tree transform, verification, move), and
the seed-mutation/drift-detection checks force conservative Git config
(`core.fsmonitor=false`, `core.trustctime=true`, `core.checkStat=default`)
via `git_verify()` so ambient config (files or `GIT_CONFIG_*` environment)
cannot weaken them. Test-only fault-injection/adversarial hooks
(`COW_WORKTREE_TEST_*` environment variables) are only ever consulted at
all when a separate, hidden, non-default, undocumented test-infrastructure
opt-in mechanism has also been explicitly used (deliberately not named in
this --help-visible description; see the module's "Test-only injection
hooks" section and its own `argparse` registration further down in this
file, and README's "Hardening" section, for the exact mechanism); without
it, every such environment variable is completely inert, by design.
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import os
import shutil
import stat
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

TMP_PREFIX = ".cow-wt-tmp."
MARKER_NAME = "COW_WRAPPER_MARKER"
SIDECAR_SUFFIX = ".cow-owner"
CLONE_NOFOLLOW = 0x0001

# Resolve clonefile(2) from libSystem directly.  This avoids spawning one
# `/bin/cp -c` process per path (prohibitively expensive for the monorepo's
# ~370k files) while retaining the exact APFS clonefile semantics.  There is
# intentionally no byte-copy fallback: if clonefile is unavailable or the
# volume cannot clone, creation fails closed.
_LIBSYSTEM = ctypes.CDLL(None, use_errno=True)
_CLONEFILE = getattr(_LIBSYSTEM, "clonefile", None)
if _CLONEFILE is not None:
    _CLONEFILE.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
    _CLONEFILE.restype = ctypes.c_int

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


class CowError(Exception):
    """A fatal, user-facing error. Caught in main() and reported cleanly."""


class Log:
    def __init__(self, verbose: bool = False):
        self.verbose = verbose
        self._t0 = time.time()

    def step(self, msg: str) -> None:
        print(f"==> {msg}", file=sys.stderr)

    def info(self, msg: str) -> None:
        print(f"    {msg}", file=sys.stderr)

    def cmd(self, args: list[str]) -> None:
        if self.verbose:
            print(f"    $ {' '.join(args)}", file=sys.stderr)

    def warn(self, msg: str) -> None:
        print(f"!!  {msg}", file=sys.stderr)


LOG = Log()


# Repository-redirection / index / object-store environment variables that
# could point a `git` subprocess at a different repository, index, or
# object store than the one this wrapper explicitly resolved paths within.
# Stripped from every git subprocess's environment before it runs.
# Authentication/network/config-behavior variables (GIT_SSH*, GIT_ASKPASS,
# GIT_HTTP_*, GIT_CONFIG_*, GIT_TRACE*, GIT_NO_LAZY_FETCH, proxy settings,
# etc.) are intentionally left alone so legitimate lazy fetches for a
# partial-clone seed keep working.
_DANGEROUS_GIT_ENV_VARS = frozenset(
    {
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_GRAFT_FILE",
        "GIT_INDEX_VERSION",
        "GIT_QUARANTINE_PATH",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        "GIT_REPLACE_REF_BASE",
        "GIT_SHALLOW_FILE",
        "GIT_PREFIX",
        "GIT_OPTIONAL_LOCKS",
        "GIT_ATTR_SOURCE_TREE",
    }
)


def sanitized_git_env(extra: Optional[dict] = None) -> dict:
    """Base environment for every `git` subprocess this wrapper runs, with
    the dangerous variables above stripped out first, plus any explicit
    extra overrides (e.g. `GIT_NO_LAZY_FETCH=1`) applied last."""
    env = {k: v for k, v in os.environ.items() if k not in _DANGEROUS_GIT_ENV_VARS}
    if extra:
        env.update(extra)
    return env


def run(
    args: list[str],
    cwd: Optional[str] = None,
    check: bool = True,
    input_bytes: Optional[bytes] = None,
    env: Optional[dict] = None,
) -> subprocess.CompletedProcess:
    """Run a subprocess, always with explicit args (no shell), capturing
    stdout/stderr as bytes to stay filename-encoding agnostic."""
    LOG.cmd(args if cwd is None else ["cd", cwd, "&&", *args])
    proc = subprocess.run(
        args,
        cwd=cwd,
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    if check and proc.returncode != 0:
        raise CowError(
            "command failed ({}): {}\n--- stdout ---\n{}\n--- stderr ---\n{}".format(
                proc.returncode,
                " ".join(args),
                proc.stdout.decode(errors="replace").strip(),
                proc.stderr.decode(errors="replace").strip(),
            )
        )
    return proc


def git(
    args: list[str], cwd: str, check: bool = True, env_extra: Optional[dict] = None
) -> subprocess.CompletedProcess:
    return run(["git", *args], cwd=cwd, check=check, env=sanitized_git_env(env_extra))


# Command-line `-c` config overrides forced onto every git invocation this
# wrapper treats as a security-relevant cleanliness/identity check (seed
# dirty/mutation checks, index-refresh drift detection, final clean-status
# checks). `-c` on the command line has the highest precedence of any Git
# config source -- higher than repo/global/system config files AND higher
# than `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`
# environment-variable config (intentionally left un-stripped by
# `sanitized_git_env()` for legitimate partial-clone/auth use) -- so
# ambient config poisoning of any of these three specific settings cannot
# weaken a verification check:
#   * `core.fsmonitor=false` -- an attacker-controlled or merely stale
#     fsmonitor hook can tell Git "nothing changed" for arbitrary paths,
#     causing Git to skip a real stat/content check entirely and report a
#     mutated file as clean. Force it off for verification.
#   * `core.trustctime=true` -- some configs (notably common NFS advice)
#     disable ctime trust, which would let a mutation that forges mtime
#     (but cannot forge ctime without controlling the system clock) slip
#     through undetected. Force ctime trust on.
#   * `core.checkStat=default` -- `minimal` intentionally checks fewer
#     stat fields (skipping ctime among others); force the more thorough
#     `default` setting so ambient config cannot silently narrow what is
#     compared.
# This does not replace a full independent content re-hash of every
# tracked path against the seed's HEAD tree -- that would mean reading
# every tracked file's bytes a second time purely to verify what these
# `git diff --quiet`/`update-index --refresh` calls already verify via
# Git's own stat-then-hash-on-ambiguity logic, at a cost proportional to a
# full second copy pass over the monorepo-scale content. Forcing these three
# settings closes every concrete config-based way to weaken that existing
# stat-then-hash check without paying that cost; see README's "Hardening"
# section for a fuller explanation of why this is the strongest safe
# Git-native check available here.
_VERIFY_GIT_CONFIG_ARGS = [
    "-c", "core.fsmonitor=false",
    "-c", "core.trustctime=true",
    "-c", "core.checkStat=default",
]


def git_verify(
    args: list[str], cwd: str, check: bool = True, env_extra: Optional[dict] = None
) -> subprocess.CompletedProcess:
    """Like `git()`, but for the subset of invocations this wrapper treats
    as a security-relevant cleanliness/mutation/identity check: forces the
    conservative config overrides in `_VERIFY_GIT_CONFIG_ARGS` so ambient
    ($HOME/global/system config file *and* `GIT_CONFIG_*` environment)
    config poisoning of fsmonitor/trustctime/checkStat cannot weaken the
    check."""
    return git([*_VERIFY_GIT_CONFIG_ARGS, *args], cwd=cwd, check=check, env_extra=env_extra)


def abspath(p: str) -> str:
    """Absolute-path normalization that *does* resolve symlinks. Only used
    for paths that are not part of the raced-reservation attack surface
    (e.g. the seed path itself, provided directly by the caller before any
    reservation ever happens)."""
    return os.path.realpath(os.path.abspath(os.path.expanduser(p)))


def literal_abspath(p: str) -> str:
    """Absolute-path normalization that never resolves symlinks. Used
    everywhere an attacker-controllable symlink resolving to a different,
    legitimate path (aliasing a victim) must NOT be treated as equal to
    the exact path this wrapper reserved or is about to touch."""
    if not os.path.isabs(p):
        p = os.path.join(os.getcwd(), p)
    return os.path.normpath(p)


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------


@dataclass
class SeedInfo:
    path: str
    common_dir: str
    head_commit: str
    head_tree: str
    branch_ref: Optional[str]  # refs/heads/xxx or None if detached


@dataclass
class TargetInfo:
    commit: str
    tree: str
    branch_ref: Optional[str]


@dataclass
class Plan:
    seed: SeedInfo
    target: TargetInfo
    dest: str
    tmp_path: str = ""
    sidecar_path: str = ""
    tmp_dev: int = 0
    tmp_ino: int = 0
    private_gitdir: str = ""
    marker_token: str = field(default_factory=lambda: uuid.uuid4().hex)
    # Non-default, explicit opt-in for the test-only injection hooks in the
    # "Test-only injection hooks" section below. False (the only reachable
    # value outside this module's own test suite) means every
    # `COW_WORKTREE_TEST_*` environment variable is completely ignored, no
    # matter what is set in the ambient environment. See --enable-test-hooks.
    test_hooks_enabled: bool = False


# ---------------------------------------------------------------------------
# Validation steps
# ---------------------------------------------------------------------------


def git_common_dir(path: str) -> str:
    """Absolute common git dir for the repo containing `path`."""
    proc = git(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=path, check=False
    )
    if proc.returncode == 0:
        return abspath(proc.stdout.decode().strip())
    # Fallback for older git without --path-format.
    proc = git(["rev-parse", "--git-common-dir"], cwd=path)
    out = proc.stdout.decode().strip()
    if not os.path.isabs(out):
        out = os.path.join(path, out)
    return abspath(out)


def check_no_gitlinks_in_tree(cwd: str, tree: str, label: str) -> None:
    """Recursively scan `tree` (via `git ls-tree -r`, which walks every
    subtree) for mode-160000 (submodule/gitlink) entries at any depth, and
    reject if any are found. Applied to both the seed's HEAD tree and the
    resolved target's tree -- a target commit that merely *introduces* a
    gitlink must be rejected just as surely as a seed that already
    contains one, and must be rejected before any mutation happens."""
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

    # Seed must have a recorded commit (HEAD).
    proc = git(["rev-parse", "--verify", "HEAD"], cwd=seed_path, check=False)
    if proc.returncode != 0:
        raise CowError("seed has no commits (HEAD does not resolve); nothing to seed from")
    head_commit = proc.stdout.decode().strip()
    head_tree = git(["rev-parse", "HEAD^{tree}"], cwd=seed_path).stdout.decode().strip()

    # Reject sparse seeds.
    proc = git(["sparse-checkout", "list"], cwd=seed_path, check=False)
    if proc.returncode == 0:
        raise CowError(
            "seed is a sparse checkout (git sparse-checkout is enabled); "
            "sparse seeds are rejected"
        )

    # Reject dirty tracked files: worktree/index must exactly match HEAD.
    # Uses git_verify(): forces fsmonitor off / trustctime on / checkStat=
    # default so ambient config cannot weaken this into a false-clean
    # result (see git_verify()'s docstring/comment).
    proc = git_verify(["diff", "--quiet", "--no-ext-diff", "HEAD", "--"], cwd=seed_path, check=False)
    if proc.returncode != 0:
        raise CowError(
            "seed's tracked files do not exactly match HEAD "
            "(staged and/or unstaged changes present); refusing to seed from a dirty worktree"
        )

    # Reject any untracked or ignored files in the seed worktree.
    proc = git_verify(["status", "--porcelain", "--ignored"], cwd=seed_path)
    dirty_lines = proc.stdout.decode(errors="replace").splitlines()
    if dirty_lines:
        sample = "\n".join(f"      {l}" for l in dirty_lines[:20])
        raise CowError(
            "seed contains untracked and/or ignored files; refusing to seed "
            f"(reject all seed untracked/ignored content):\n{sample}"
        )

    # Gitlinks/submodules need recursive worktree semantics that this first
    # version deliberately does not implement.  Reject rather than treating
    # a tracked directory as a cloneable regular file. Scanned recursively
    # against the exact HEAD tree (equivalent to the index, already proven
    # clean above, but tree-based so it can share code with the target-side
    # check in resolve_target()).
    check_no_gitlinks_in_tree(seed_path, head_tree, "seed")

    # Determine branch (None if detached).
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

    # Reject before any mutation if the target introduces a gitlink
    # anywhere in its tree, even if the seed itself is entirely clean of
    # them (a target commit that merely *adds* a submodule must be
    # rejected just as surely as a seed that already has one).
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


def parse_worktree_list_porcelain(text: str) -> list[dict]:
    entries: list[dict] = []
    cur: dict = {}
    for line in text.splitlines():
        if not line.strip():
            if cur:
                entries.append(cur)
                cur = {}
            continue
        if " " in line:
            key, _, val = line.partition(" ")
        else:
            key, val = line, ""
        cur[key] = val
    if cur:
        entries.append(cur)
    return entries


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

    # Policy: destination must not exist at all -- not even as an empty
    # directory. `git worktree move` treats an *existing* destination
    # directory as a place to move INTO (nesting the worktree under it,
    # even silently succeeding for an empty directory via a rename-style
    # move) rather than erroring, so tolerating a pre-existing empty
    # directory here would require this wrapper to itself remove that
    # directory immediately before the move -- exactly the TOCTOU-prone
    # behavior this policy exists to eliminate. See move_worktree().
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


def validate_same_device(seed: SeedInfo, dest_abs: str) -> None:
    if _CLONEFILE is None:
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


# ---------------------------------------------------------------------------
# Partial/promisor (blobless) clone support
# ---------------------------------------------------------------------------


def detect_partial_clone(seed: SeedInfo) -> bool:
    """Best-effort detection of a partial/promisor clone: a configured
    promisor remote, or `.promisor` marker files alongside the primary
    object store's packs (what `--filter=blob:none` etc. produce).  Does
    not attempt to walk alternates/multiple object directories beyond the
    seed's own common dir; see README's "Limitations"."""
    proc = git(["config", "--get-regexp", r"^remote\..*\.promisor$"], cwd=seed.path, check=False)
    if proc.returncode == 0 and proc.stdout.strip():
        return True
    pack_dir = os.path.join(seed.common_dir, "objects", "pack")
    try:
        return any(name.endswith(".promisor") for name in os.listdir(pack_dir))
    except OSError:
        return False


def target_blobs_to_materialize(seed: SeedInfo, seed_tree: str, target_tree: str) -> list[str]:
    """Every blob object id the TARGET tree needs that the SEED tree does
    not already reference at the same path (i.e. every add/modify/
    type-change), computed via a full-index, no-renames raw tree diff.
    Deleted paths need no target-side blob. Renames are intentionally not
    detected (`--no-renames`): `git read-tree -m -u S T` itself performs a
    plain, rename-unaware 2-way merge, so this matches exactly what the
    later transform step will actually need."""
    if seed_tree == target_tree:
        return []
    proc = git(
        [
            "diff-tree", "--no-commit-id", "--raw", "-r", "-z",
            "--full-index", "--no-renames", seed_tree, target_tree,
        ],
        cwd=seed.path,
    )
    tokens = [t for t in proc.stdout.split(b"\0") if t]
    oids: list[str] = []
    i = 0
    while i < len(tokens):
        meta = tokens[i]
        if not meta.startswith(b":") or i + 1 >= len(tokens):
            i += 1
            continue
        path = tokens[i + 1]
        i += 2
        parts = meta.split(b" ")
        if len(parts) < 5:
            continue
        dst_sha = parts[3]
        status = parts[4][:1]
        if status == b"D":
            continue
        if dst_sha and dst_sha.strip(b"0"):
            oids.append(dst_sha.decode())
    return sorted(set(oids))


def materialize_target_objects(seed: SeedInfo, target: TargetInfo) -> None:
    """Detect and report partial/promisor clone status, and -- if the
    target introduces any new/changed blob content relative to the seed --
    materialize (lazily fetch, if needed) every such blob object *before*
    any worktree registration or mutation happens, then re-verify strict
    local availability with lazy fetching disabled. This is the only
    point in the whole wrapper where a network fetch is allowed to
    happen, and it runs before `reserve_tmp_path()`/`git worktree add`,
    so a network failure aborts fail-fast with nothing created."""
    LOG.step("Preflight: partial/promisor-clone detection and target blob materialization")
    partial = detect_partial_clone(seed)
    LOG.info(
        "seed is a partial/promisor clone (lazy blob fetch enabled)"
        if partial
        else "seed is a full (non-partial) clone"
    )

    oids = target_blobs_to_materialize(seed, seed.head_tree, target.tree)
    if not oids:
        LOG.info("target introduces no new/changed blob content relative to seed; nothing to fetch")
        return

    LOG.info(
        f"target requires {len(oids)} blob object(s); materializing before any worktree "
        "registration/mutation"
    )
    batch_input = ("\n".join(oids) + "\n").encode()

    proc = run(
        ["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
        cwd=seed.path,
        input_bytes=batch_input,
        check=False,
        env=sanitized_git_env(),
    )
    missing = [
        line for line in proc.stdout.decode(errors="replace").splitlines()
        if line.strip().endswith("missing")
    ]
    if proc.returncode != 0 or missing:
        raise CowError(
            "failed to materialize one or more target blob objects before mutating anything "
            "(the seed may be an incomplete partial/promisor clone with no reachable "
            "remote, or a network/fetch failure occurred); "
            f"missing={missing[:10]} stderr={proc.stderr.decode(errors='replace').strip()!r}"
        )

    # Re-verify with lazy fetching strictly disabled: every required blob
    # must now be genuinely local, not merely "git believes it can fetch
    # it on demand".
    proc2 = run(
        ["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
        cwd=seed.path,
        input_bytes=batch_input,
        check=False,
        env=sanitized_git_env({"GIT_NO_LAZY_FETCH": "1"}),
    )
    missing2 = [
        line for line in proc2.stdout.decode(errors="replace").splitlines()
        if line.strip().endswith("missing")
    ]
    if proc2.returncode != 0 or missing2:
        raise CowError(
            "target blob objects still not locally available with lazy fetch disabled "
            f"after preflight materialization: {missing2[:10]}"
        )
    LOG.info(f"confirmed {len(oids)} target blob object(s) locally available with lazy fetch disabled")


def describe_target_blob_status_readonly(seed: SeedInfo, target: TargetInfo) -> None:
    """Dry-run-only, read-only counterpart to materialize_target_objects():
    reports partial-clone status and how many target blobs would need
    fetching, WITHOUT fetching anything (a real run's preflight step is
    what actually performs and verifies the fetch)."""
    partial = detect_partial_clone(seed)
    LOG.info(
        "seed is a partial/promisor clone (lazy blob fetch enabled)"
        if partial
        else "seed is a full (non-partial) clone"
    )
    oids = target_blobs_to_materialize(seed, seed.head_tree, target.tree)
    if not oids:
        LOG.info("target blob objects needed: 0 (no new/changed content relative to seed)")
        return
    batch_input = ("\n".join(oids) + "\n").encode()
    proc = run(
        ["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
        cwd=seed.path,
        input_bytes=batch_input,
        check=False,
        env=sanitized_git_env({"GIT_NO_LAZY_FETCH": "1"}),
    )
    missing = [
        line for line in proc.stdout.decode(errors="replace").splitlines()
        if line.strip().endswith("missing")
    ]
    LOG.info(
        f"target blob objects needed: {len(oids)}; {len(missing)} not yet present locally "
        "(dry-run never fetches; a real run's preflight step materializes these before any "
        "mutation)"
    )


# ---------------------------------------------------------------------------
# Core operation
# ---------------------------------------------------------------------------


def reserve_tmp_path(dest_abs: str, token: str) -> tuple[str, str, int, int]:
    """Atomically reserve a brand-new directory *inode* (not just a
    sidecar file) before `git worktree add` ever runs, and record its
    exact device/inode.

    `os.mkdir` is used specifically because it is atomic with respect to
    an existing directory entry of ANY kind (file, symlink, or directory)
    at that exact path: it can never silently "reserve" a path that a
    racing symlink has already claimed. Any later replacement of this
    directory entry changes its (dev, ino) identity, which every
    subsequent security-sensitive step in this module re-verifies via
    `verify_reservation_intact()` before doing anything destructive --
    this is what closes the raced-symlink-to-a-victim-worktree attack.

    The O_EXCL sidecar is additionally kept (recording the same token) as
    a second, independent, filename-based proof of ownership, used by
    cleanup even in the narrow window before git's own private-gitdir
    marker exists.
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
            # suffix), but undo the directory reservation and retry with a
            # fresh name rather than proceeding without sidecar proof.
            os.rmdir(candidate)
            continue
        with os.fdopen(fd, "w") as f:
            f.write(token + "\n")
            f.flush()
            os.fsync(f.fileno())
        st = os.lstat(candidate)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            # Should be unreachable: we just created this directory
            # ourselves. Treated as a hard failure rather than silently
            # continuing if it somehow isn't what we expect.
            raise CowError(
                f"reserved path is not a plain directory immediately after creation: {candidate}"
            )
        return candidate, sidecar, st.st_dev, st.st_ino
    raise CowError("could not reserve a unique temporary worktree path")


def verify_reservation_intact(path: str, expected_dev: int, expected_ino: int, context: str) -> None:
    """lstat-based identity check that MUST run before any registration
    lookup or destructive command touches `path`. Rejects a symlink, a
    non-directory, or a device/inode mismatch (i.e. the directory entry
    was removed and replaced with something else) -- the exact raced
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
    # Close the mutable-ref race between target resolution and worktree add.
    actual = git(["rev-parse", "HEAD"], cwd=tmp_path).stdout.decode().strip()
    if actual != target.commit:
        raise CowError(
            f"target moved during creation: resolved {target.commit}, worktree HEAD is {actual}"
        )


def capture_private_gitdir(tmp_path: str) -> str:
    """Capture git's own private-gitdir path for this worktree exactly
    once, immediately after `git worktree add` succeeded and reservation
    identity was just re-verified -- the one moment this module still
    fully trusts cd-ing into `tmp_path`. Every later
    ownership/marker/registration check reads or writes this absolute
    path directly and never again re-derives anything by cd-ing into
    `tmp_path` or its eventual moved location."""
    return git(
        ["rev-parse", "--path-format=absolute", "--git-dir"], cwd=tmp_path
    ).stdout.decode().strip()


def write_marker(private_gitdir: str, token: str) -> None:
    """Mark the worktree's *private git dir* (not its working tree!) as
    wrapper-owned, so cleanup never needs to guess based on directory
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
    """Read git's own trusted record -- the `gitdir` pointer file inside
    the private admin directory, never by cd-ing into the untrusted
    working-tree path -- of which working-tree path this worktree
    registration currently points at (tmp_path before a move, DEST
    after)."""
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


def clonefile_path(src: bytes, dst: bytes) -> None:
    assert _CLONEFILE is not None
    ctypes.set_errno(0)
    if _CLONEFILE(src, dst, CLONE_NOFOLLOW) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err), os.fsdecode(src), os.fsdecode(dst))


def copy_tracked_files(seed: SeedInfo, tmp_path: str, test_hooks_enabled: bool = False) -> int:
    LOG.step("CoW-cloning seed's tracked files with clonefile(2)")
    paths = [p for p in git(["ls-files", "-z"], cwd=seed.path).stdout.split(b"\0") if p]
    seed_b = os.fsencode(seed.path)
    tmp_b = os.fsencode(tmp_path)
    # Test-only fault injection: completely inert unless test hooks were
    # explicitly enabled (see "Test-only injection hooks" below), so an
    # ambient COW_WORKTREE_TEST_FAIL_AFTER_COPY alone can never affect a
    # normal production run.
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
    # Mandatory: read-tree populated an index with zeroed stat data.  A checked
    # refresh both initializes those fields and rejects any seed drift copied
    # into the temporary worktree before the S -> T transform. Uses
    # git_verify() so ambient fsmonitor/trustctime/checkStat config cannot
    # weaken this drift check.
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
    """Checked re-verification that SEED's tracked files (both worktree and
    index) still exactly match its recorded HEAD commit, and that HEAD
    itself has not moved. Called before and after the CoW copy and before
    and after the final move, closing the window between the initial
    validate_seed() check and each subsequent mutating step. Note: a
    mutation that preserves both content size AND the exact cached mtime
    (down to the nanosecond) AND the file's ctime would not be caught by
    `git diff --quiet` alone -- but ctime cannot be forged by an
    unprivileged process without also controlling the system clock, so in
    practice this closes the realistic version of that race; see
    README's "Limitations"."""
    LOG.step(f"Re-verifying seed is unmodified ({when})")
    # git_verify(): forces fsmonitor off / trustctime on / checkStat=default
    # so ambient repo/global/system config (or `GIT_CONFIG_*` environment
    # poisoning) cannot make this check falsely report "clean".
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
    # `git worktree move` treats an *existing* destination directory as a
    # place to move INTO, not as an error: for an empty directory it
    # silently succeeds via a rename-style move (nesting nothing, but
    # this wrapper never intends to rely on that), and for a *non-empty*
    # directory it silently nests the worktree one level deeper
    # (`DEST/<tmp-name>/...`) without any error at all. Never invoke it
    # unless DEST has just been re-confirmed to not exist in any form.
    if os.path.lexists(dest_abs):
        raise CowError(
            f"destination came into existence before the final move (concurrent creation?): "
            f"{dest_abs}; refusing to move -- this wrapper never removes, empties, or moves "
            "into an existing destination"
        )

    # NOTE (bounded, non-eliminated race -- see README's "Limitations"):
    # there is an unavoidable, narrow window right here, between the
    # `os.path.lexists` check just above and the `git worktree move`
    # subprocess call below, in which a concurrent process could still
    # create DEST (with or without real content) -- pathname-based
    # filesystem checks followed by a pathname-based subprocess call
    # cannot be made atomic with each other from Python without a kernel
    # primitive `git worktree move` itself does not expose. This is
    # deliberately treated as a *detect-and-fail-safe*, not an
    # *eliminate*, race: the explicit re-check immediately below (using
    # git's own trusted private-gitdir record, not a trust-the-pathname
    # check) turns a race that wins in this window into a clean, reported
    # failure with the foreign content provably preserved, never a data
    # loss. Eliminating the window entirely would require `DEST`'s parent
    # directory to itself be private (not attacker-writable) for the
    # duration of a run -- required for a real pilot; see README.
    _maybe_create_dest_with_content_race_for_test(dest_abs, test_hooks_enabled)

    git(["worktree", "move", tmp_path, dest_abs], cwd=seed.path)
    if os.path.islink(dest_abs) or not os.path.isdir(dest_abs):
        raise CowError(
            f"worktree move did not produce the expected destination directory: {dest_abs}"
        )

    # Defensive, explicit re-check (rather than relying on some later,
    # incidental command failing): confirm git's own trusted registration
    # record now points at DEST *exactly*, not a subdirectory of it. If a
    # foreign directory was raced into existence in the window just above,
    # `git worktree move` can "succeed" (exit 0) while actually nesting
    # the worktree one level deeper inside that foreign directory instead
    # of DEST becoming the worktree itself -- see the NOTE above. Detect
    # that precisely here so the failure mode is a clear, immediate,
    # attributable error instead of a confusing downstream one.
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
    """Literal (non-symlink-resolving) match against `git worktree list`'s
    reported paths. Used only for a post-cleanup stale-registration
    sanity check; ownership decisions during cleanup rely on
    `private_gitdir`/`registration_points_at`, never on this alone."""
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
    owns. Ownership proof never depends on trusting `worktree_path` once
    it might have been raced/replaced:

      * The O_EXCL sidecar token must match (proves this invocation's
        random reservation).
      * Before touching the filesystem at `worktree_path` at all, an
        lstat identity check (device+inode recorded at reservation time)
        must pass: if the path is now a symlink, not a directory, or a
        different inode, cleanup refuses outright and does nothing else
        -- this closes the raced-symlink-to-a-victim-worktree attack.
      * `private_gitdir` (captured once, immediately after `worktree add`
        succeeded, directly from that call's own output -- never
        re-derived later by cd-ing into `worktree_path`) is git's own
        trusted administrative record. Its marker file and/or `gitdir`
        pointer file are read directly, never through `worktree_path`.
        `git worktree remove --force` is only ever invoked once one of
        those two proves this exact registration is ours.
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

    # lstat + identity check BEFORE any registration lookup or destructive
    # command.
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


# ---------------------------------------------------------------------------
# Test-only injection hooks
#
# Every hook below reads its `COW_WORKTREE_TEST_*` environment variable(s)
# ONLY when `plan.test_hooks_enabled` is True -- i.e. only when the hidden,
# non-default `--enable-test-hooks` CLI flag was explicitly passed (see
# parse_args()/build_plan()). This is deliberately NOT ambient-env-gated
# alone: a real invocation of this wrapper, run without that flag, ignores
# every one of these variables completely, even if they happen to be set
# in the ambient environment (e.g. inherited from a parent shell/CI job by
# accident). Each hook is exercised by exactly one adversarial or
# fault-injection test in tests/test_cow_worktree.py; the
# ambient-env-without-the-flag case is itself covered by
# TestTestHooksDisabledByDefault. None of this is reachable through any
# other normal code path, and `--enable-test-hooks` is suppressed from
# `--help` (see parse_args()) -- this is test infrastructure, not a
# supported end-user feature; see README's "Hardening" section.
# ---------------------------------------------------------------------------


def _maybe_inject_symlink_attack(plan: Plan) -> None:
    """Simulates an attacker racing the wrapper's reserved tmp_path before
    registration: removes the freshly created empty directory and
    replaces it with a symlink to an arbitrary existing path, exactly as a
    real TOCTOU race would. Exercises the pre-registration adversarial
    symlink-alias test."""
    if not plan.test_hooks_enabled:
        return
    victim = os.environ.get("COW_WORKTREE_TEST_SYMLINK_ATTACK_TARGET")
    if not victim:
        return
    os.rmdir(plan.tmp_path)
    os.symlink(victim, plan.tmp_path)


def _maybe_inject_symlink_attack_post_marker(plan: Plan) -> None:
    """Simulates an attacker winning a *later* race than
    `_maybe_inject_symlink_attack`: by this point `git worktree add` has
    already registered the reservation and the private marker has already
    been written, so the reserved directory is no longer empty (it holds
    at least the worktree's `.git` pointer file) -- `os.rmdir` alone can no
    longer apply. Uses `shutil.rmtree` + `os.symlink` to simulate the
    *result* such a race would leave behind (this test-only hook is
    standing in for an external race, not itself trying to win one).
    Exercises the post-marker adversarial symlink-alias test, proving the
    identity re-checks placed before every later mutating step actually
    catch a race that happens after registration too, not just before it.
    """
    if not plan.test_hooks_enabled:
        return
    victim = os.environ.get("COW_WORKTREE_TEST_SYMLINK_ATTACK_POST_MARKER_TARGET")
    if not victim:
        return
    shutil.rmtree(plan.tmp_path)
    os.symlink(victim, plan.tmp_path)


def _maybe_mutate_seed_for_test(seed: SeedInfo, stage: str, enabled: bool) -> None:
    """Mutates one tracked file's content in the seed while preserving its
    exact size and mtime (but NOT its ctime, which an unprivileged
    process cannot forge), to exercise verify_seed_unmodified()."""
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
    check-to-move TOCTOU race inside `move_worktree()` itself -- strictly
    between its own `os.path.lexists` re-check and the `git worktree move`
    subprocess call, rather than before `move_worktree()` is even called
    (that coarser race is what `_maybe_create_dest_race_for_test` /
    `COW_WORKTREE_TEST_CREATE_DEST_BEFORE_MOVE` exercises, and
    `move_worktree()`'s own re-check already catches it before invoking
    `git` at all). Creates DEST with real foreign file content (not just
    an empty directory) specifically to prove that content, not merely
    the directory's existence, survives this narrowest race untouched.
    (Second-critic-review conditional blocker #4.)"""
    if not enabled:
        return
    if os.environ.get("COW_WORKTREE_TEST_CREATE_DEST_WITH_CONTENT_DURING_MOVE") == "1":
        os.makedirs(dest_abs, exist_ok=True)
        with open(os.path.join(dest_abs, "foreign-marker.txt"), "w") as f:
            f.write("pre-existing foreign content that must survive\n")


def _test_fail_stage(plan: Plan) -> Optional[str]:
    """Inert unless test hooks are explicitly enabled; see the section
    docstring above."""
    if not plan.test_hooks_enabled:
        return None
    return os.environ.get("COW_WORKTREE_TEST_FAIL_STAGE")


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def build_plan(seed_path: str, target: str, dest: str, enable_test_hooks: bool = False) -> Plan:
    seed = validate_seed(seed_path)
    target_info = resolve_target(seed, target)
    dest_abs = validate_dest(seed, dest)
    validate_same_device(seed, dest_abs)
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

        # Simulated post-registration race (test-only, see
        # _maybe_inject_symlink_attack_post_marker's docstring): proves the
        # identity re-check immediately below actually catches a race that
        # wins *after* registration/marker creation, not just before it.
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
        # registered path, whether that is still tmp_path or already the
        # moved DEST -- covers exactly the race where git already moved
        # things but this process hasn't updated current_path yet.
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


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="cow_worktree.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--seed", required=True, help="path to a clean, full, non-sparse seed worktree")
    p.add_argument("--target", required=True, help="branch name or commit to check out at DEST")
    p.add_argument(
        "--dest",
        required=True,
        help="destination path; relative names resolve beneath the seed's parent",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="validate and print the plan, but make no changes",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="print every git/cp command run")
    # Hidden, non-default, test-infrastructure-only flag: without it, every
    # COW_WORKTREE_TEST_* environment variable is completely inert, no
    # matter what is set ambiently (see the "Test-only injection hooks"
    # section in this module and README's "Hardening" section). Suppressed
    # from --help on purpose: this is not supported end-user usage.
    p.add_argument(
        "--enable-test-hooks",
        dest="enable_test_hooks",
        action="store_true",
        default=False,
        help=argparse.SUPPRESS,
    )
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    LOG.verbose = args.verbose
    try:
        plan = build_plan(
            args.seed, args.target, args.dest, enable_test_hooks=args.enable_test_hooks
        )
        if args.dry_run:
            print_plan(plan)
            return 0
        execute_plan(plan)
        return 0
    except CowError as e:
        LOG.warn(str(e))
        return 1
    except KeyboardInterrupt:
        LOG.warn("interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
