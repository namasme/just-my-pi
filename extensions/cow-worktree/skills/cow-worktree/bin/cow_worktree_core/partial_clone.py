"""Partial/promisor (blobless) seed support: detect, and materialize
target blobs before any worktree registration or mutation. See
references/design.md, "Partial/blobless clone support"."""
from __future__ import annotations

import os

from .errors import CowError
from .gitenv import git, run, sanitized_git_env
from .log import LOG
from .models import SeedInfo, TargetInfo


def detect_partial_clone(seed: SeedInfo) -> bool:
    """Best-effort detection via a configured promisor remote or
    `.promisor` pack marker files. Does not walk alternates/multiple
    object directories beyond the seed's own common dir."""
    proc = git(["config", "--get-regexp", r"^remote\..*\.promisor$"], cwd=seed.path, check=False)
    if proc.returncode == 0 and proc.stdout.strip():
        return True
    pack_dir = os.path.join(seed.common_dir, "objects", "pack")
    try:
        return any(name.endswith(".promisor") for name in os.listdir(pack_dir))
    except OSError:
        return False


def target_blobs_to_materialize(seed: SeedInfo, seed_tree: str, target_tree: str) -> list[str]:
    """Every blob oid the TARGET tree needs that SEED doesn't already have
    at the same path (add/modify/type-change; deletes need no blob),
    computed via a full-index, no-renames raw tree diff. `--no-renames`
    matches `git read-tree -m -u S T`, which itself is a plain,
    rename-unaware 2-way merge."""
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


def _batch_check_missing(seed: SeedInfo, oids: list[str], env: dict):
    batch_input = ("\n".join(oids) + "\n").encode()
    proc = run(
        ["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
        cwd=seed.path,
        input_bytes=batch_input,
        check=False,
        env=env,
    )
    missing = [
        line for line in proc.stdout.decode(errors="replace").splitlines()
        if line.strip().endswith("missing")
    ]
    return proc, missing


def materialize_target_objects(seed: SeedInfo, target: TargetInfo) -> None:
    """The only point in the whole run where a network fetch is allowed:
    runs strictly before reserve_tmp_path()/`git worktree add`, so a
    network failure aborts fail-fast with nothing created. Fetches
    (`git cat-file --batch-check`, triggering Git's lazy-fetch machinery)
    every blob the target needs, then re-verifies genuine local
    availability with lazy fetching disabled, so a lazy-fetch "success"
    that didn't actually persist the object locally is still caught."""
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
    proc, missing = _batch_check_missing(seed, oids, sanitized_git_env())
    if proc.returncode != 0 or missing:
        raise CowError(
            "failed to materialize one or more target blob objects before mutating anything "
            "(the seed may be an incomplete partial/promisor clone with no reachable "
            f"remote, or a network/fetch failure occurred); missing={missing[:10]} "
            f"stderr={proc.stderr.decode(errors='replace').strip()!r}"
        )

    proc2, missing2 = _batch_check_missing(seed, oids, sanitized_git_env({"GIT_NO_LAZY_FETCH": "1"}))
    if proc2.returncode != 0 or missing2:
        raise CowError(
            "target blob objects still not locally available with lazy fetch disabled "
            f"after preflight materialization: {missing2[:10]}"
        )
    LOG.info(f"confirmed {len(oids)} target blob object(s) locally available with lazy fetch disabled")


def describe_target_blob_status_readonly(seed: SeedInfo, target: TargetInfo) -> None:
    """Dry-run-only, read-only counterpart to materialize_target_objects():
    reports what would need fetching WITHOUT fetching anything."""
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
    _proc, missing = _batch_check_missing(seed, oids, sanitized_git_env({"GIT_NO_LAZY_FETCH": "1"}))
    LOG.info(
        f"target blob objects needed: {len(oids)}; {len(missing)} not yet present locally "
        "(dry-run never fetches; a real run's preflight step materializes these before any "
        "mutation)"
    )
