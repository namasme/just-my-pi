"""Fixture builders: construct seed repositories with known content,
branches, executable bits, symlinks, and tricky filenames."""
import os
import stat

from helpers import git, init_repo


def write(path, content):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def build_base_repo(root):
    """Create a repo at root/repo with a base commit `main` containing:
    - a regular tracked file
    - a nested tracked file
    - an executable script (mode 755)
    - a symlink
    - a file with a space in its name
    - a file with unicode in its name
    Returns dict with paths and the repo dir.
    """
    repo = os.path.join(root, "repo")
    init_repo(repo)

    os.makedirs(os.path.join(repo, "a", "b"), exist_ok=True)
    write(os.path.join(repo, "a", "b", "f1.txt"), "hello\n")
    write(os.path.join(repo, "top.txt"), "top level\n")

    script = os.path.join(repo, "a", "exec.sh")
    write(script, "#!/bin/sh\necho hi\n")
    os.chmod(script, 0o755)

    os.symlink("a/b/f1.txt", os.path.join(repo, "link1"))

    write(os.path.join(repo, "file with space.txt"), "spacey\n")

    unicode_dir = os.path.join(repo, "unicode-café")
    os.makedirs(unicode_dir, exist_ok=True)
    write(os.path.join(unicode_dir, "日本語ファイル.txt"), "unicode content\n")

    git(["add", "-A"], cwd=repo)
    git(["commit", "-q", "-m", "base commit"], cwd=repo)

    return repo


def add_divergent_branch(repo, branch="feature"):
    """From current HEAD (main), create `branch` with adds/modifies/deletes
    and a rename, relative to the base commit. Leaves HEAD back on main."""
    git(["branch", branch], cwd=repo)
    git(["checkout", "-q", branch], cwd=repo)

    # modify
    write(os.path.join(repo, "a", "b", "f1.txt"), "hello MODIFIED\n")
    # delete
    os.remove(os.path.join(repo, "a", "exec.sh"))
    # add
    os.makedirs(os.path.join(repo, "a", "c"), exist_ok=True)
    write(os.path.join(repo, "a", "c", "new.txt"), "new file\n")
    # add a new executable + new symlink to exercise mode/symlink creation
    # during the read-tree -u transform itself (not just the initial copy).
    new_script = os.path.join(repo, "a", "c", "new_exec.sh")
    write(new_script, "#!/bin/sh\necho new\n")
    os.chmod(new_script, 0o755)
    os.symlink("a/c/new.txt", os.path.join(repo, "link2"))
    # rename (git detects add+delete of identical/near-identical content as
    # a rename in `git diff --stat -M`; the tree itself just records the
    # new path and the removal of the old one).
    os.rename(
        os.path.join(repo, "file with space.txt"),
        os.path.join(repo, "file with space (renamed).txt"),
    )

    git(["add", "-A"], cwd=repo)
    git(["commit", "-q", "-m", "feature: adds/modifies/deletes/renames"], cwd=repo)

    git(["checkout", "-q", "main"], cwd=repo)
    return branch


def build_promisor_seed(root):
    """Build a genuinely blobless (promisor/partial-clone) seed for the
    partial-clone preflight-materialization tests.

    A plain `git clone --filter=blob:none file://...` of a *local* path
    does NOT produce a real partial clone: git's local-transport fast
    path (hardlinking/copying objects directly) silently ignores the
    filter. `--no-local` forces the smart-protocol (upload-pack) path
    instead, which does honor `--filter`, so this is the combination
    needed for a genuinely blobless seed even with a `file://` origin.
    `uploadpack.allowfilter` must also be enabled on the origin side, or
    upload-pack ignores the filter and warns
    "filtering not recognized by server" instead.

    Returns a dict with:
      - origin: path to the origin repo (has `main` checked out, plus a
        `feature` branch whose tracked file content is entirely
        different from `main`'s, so every changed blob gets a distinct
        SHA that main's checkout could not have already fetched).
      - seed: path to the blobless clone, checked out at `main`, with a
        local `feature` branch (tracking `origin/feature`, not checked
        out anywhere) whose blobs are provably NOT present locally with
        lazy fetching disabled.
      - feature_missing_blob: the object id of one such missing blob,
        for tests that want to assert on it directly.

    Raises unittest.SkipTest (via the caller checking the returned None)
    if the local git/platform does not support a real partial clone this
    way (older git, or a transport that still ignores the filter).
    """
    origin = os.path.join(root, "origin")
    init_repo(origin)
    os.makedirs(os.path.join(origin, "data"), exist_ok=True)
    for i in range(3):
        write(os.path.join(origin, "data", f"f{i}.txt"), f"base content {i}\n")
    git(["add", "-A"], cwd=origin)
    git(["commit", "-q", "-m", "base"], cwd=origin)

    git(["checkout", "-q", "-b", "feature"], cwd=origin)
    for i in range(3):
        write(os.path.join(origin, "data", f"f{i}.txt"), f"feature content {i} totally different\n")
    write(os.path.join(origin, "data", "new.txt"), "brand new file on feature\n")
    git(["add", "-A"], cwd=origin)
    git(["commit", "-q", "-m", "feature"], cwd=origin)
    git(["checkout", "-q", "main"], cwd=origin)

    # Required for upload-pack (the smart-protocol server side, which
    # --no-local forces even a file:// clone through) to honor --filter
    # instead of silently ignoring it.
    git(["config", "uploadpack.allowfilter", "true"], cwd=origin)

    seed = os.path.join(root, "seed")
    proc = git(
        ["clone", "-q", "--no-local", "--filter=blob:none", f"file://{origin}", seed],
        cwd=root,
        check=False,
    )
    if proc.returncode != 0:
        return None
    git(["config", "user.email", "test@example.com"], cwd=seed)
    git(["config", "user.name", "Cow Test"], cwd=seed)
    git(["branch", "feature", "origin/feature"], cwd=seed)

    missing_blob = git(
        ["rev-parse", "feature:data/f0.txt"], cwd=seed
    ).stdout.decode().strip()

    # Confirm this really is blobless: the origin-side promisor marker
    # must be present, and the feature-only blob must genuinely be
    # missing locally with lazy fetching disabled.
    promisor_cfg = git(
        ["config", "--get-regexp", r"^remote\..*\.promisor$"], cwd=seed, check=False
    )
    if promisor_cfg.returncode != 0 or not promisor_cfg.stdout.strip():
        return None
    check = git(
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        cwd=seed,
        check=False,
    )
    # cat-file reads stdin; re-run with explicit input via subprocess since
    # helpers.git() doesn't support stdin -- do it directly here.
    import subprocess as _subprocess

    proc2 = _subprocess.run(
        ["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
        cwd=seed,
        input=(missing_blob + "\n").encode(),
        stdout=_subprocess.PIPE,
        stderr=_subprocess.PIPE,
        env={**os.environ, "GIT_NO_LAZY_FETCH": "1"},
    )
    if b"missing" not in proc2.stdout:
        return None

    return {
        "origin": origin,
        "seed": seed,
        "feature_missing_blob": missing_blob,
    }
