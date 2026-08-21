"""Subprocess helpers and environment/config sanitization for every `git`
invocation this wrapper makes. See references/design.md, "Safety
mechanisms" #5, and the "Algorithm" section's step 10, for the full
threat-model writeup."""
from __future__ import annotations

import os
import subprocess
from typing import Optional

from .errors import CowError
from .log import LOG

# Repository-redirection / index / object-store variables that could point
# a `git` subprocess at a different repository, index, or object store than
# the one this wrapper explicitly resolved as `cwd`. Stripped from every
# git subprocess's environment. Authentication/network/config-behavior
# variables (GIT_SSH*, GIT_ASKPASS, GIT_HTTP_*, GIT_CONFIG_*, GIT_TRACE*,
# GIT_NO_LAZY_FETCH, proxies, etc.) are deliberately left alone so a
# partial-clone seed's legitimate lazy fetches keep working.
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
    """Base environment for every `git` subprocess: `_DANGEROUS_GIT_ENV_VARS`
    stripped first, then any explicit `extra` overrides applied last."""
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
    """Run a subprocess with explicit args (no shell); stdout/stderr are
    captured as bytes to stay filename-encoding agnostic."""
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


# Forced onto every git invocation this wrapper treats as a security-
# relevant cleanliness/identity check. `-c` on the command line outranks
# every other Git config source, including `GIT_CONFIG_*` environment
# config (intentionally left un-stripped above for partial-clone/auth
# use), so ambient poisoning of these three settings can't produce a
# false "clean" result:
#   * core.fsmonitor=false -- a stale/malicious fsmonitor hook can claim
#     "nothing changed" and skip the real check entirely.
#   * core.trustctime=true -- some (e.g. NFS) advice disables ctime trust,
#     which would let an mtime-preserving mutation slip through.
#   * core.checkStat=default -- `minimal` compares fewer stat fields
#     (including ctime); force the full comparison.
# This does not replace a full content re-hash of every tracked file --
# that would cost a second full read pass at monorepo scale purely to
# duplicate what Git's own stat-then-hash logic already does once these
# three settings are forced conservative.
_VERIFY_GIT_CONFIG_ARGS = [
    "-c", "core.fsmonitor=false",
    "-c", "core.trustctime=true",
    "-c", "core.checkStat=default",
]


def git_verify(
    args: list[str], cwd: str, check: bool = True, env_extra: Optional[dict] = None
) -> subprocess.CompletedProcess:
    """Like `git()`, but forces `_VERIFY_GIT_CONFIG_ARGS` for the subset of
    invocations that are a security-relevant cleanliness/mutation/identity
    check, so ambient config (files or `GIT_CONFIG_*` env) can't weaken
    them."""
    return git([*_VERIFY_GIT_CONFIG_ARGS, *args], cwd=cwd, check=check, env_extra=env_extra)


def abspath(p: str) -> str:
    """Absolute-path normalization that resolves symlinks. Only used for
    paths outside the raced-reservation attack surface (e.g. the seed
    path, provided directly by the caller before any reservation)."""
    return os.path.realpath(os.path.abspath(os.path.expanduser(p)))


def literal_abspath(p: str) -> str:
    """Absolute-path normalization that never resolves symlinks. Used
    wherever an attacker-controlled symlink aliasing a different,
    legitimate path must NOT be treated as equal to a path this wrapper
    reserved or is about to touch."""
    if not os.path.isabs(p):
        p = os.path.join(os.getcwd(), p)
    return os.path.normpath(p)


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
