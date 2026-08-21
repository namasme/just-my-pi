"""Shared helpers for cow_worktree.py tests."""
import os
import shutil
import subprocess
import sys
import uuid

LAB_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRATCH_ROOT = os.path.join(LAB_DIR, "tests", "_scratch")
WRAPPER = os.path.join(LAB_DIR, "bin", "cow_worktree.py")

# Guard rail: tests may only ever touch paths inside this lab directory.
# realpath() resolves symlinks first, so escapes are caught here.


def _guard(path: str) -> None:
    real = os.path.realpath(path)
    if not real.startswith(LAB_DIR):
        raise RuntimeError(f"refusing to touch path outside lab: {real}")


def new_scratch_dir(name: str) -> str:
    os.makedirs(SCRATCH_ROOT, exist_ok=True)
    path = os.path.join(SCRATCH_ROOT, f"{name}-{uuid.uuid4().hex[:8]}")
    _guard(path)
    os.makedirs(path)
    return path


def sh(args, cwd=None, check=True, env=None):
    _guard(cwd or os.getcwd())
    proc = subprocess.run(
        args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    if check and proc.returncode != 0:
        raise AssertionError(
            f"command failed ({proc.returncode}): {args}\n"
            f"stdout: {proc.stdout.decode(errors='replace')}\n"
            f"stderr: {proc.stderr.decode(errors='replace')}"
        )
    return proc


def git(args, cwd, check=True):
    return sh(["git", *args], cwd=cwd, check=check)


def init_repo(path):
    os.makedirs(path, exist_ok=True)
    _guard(path)
    git(["init", "-q", "-b", "main", path], cwd=os.path.dirname(path) or ".")
    git(["config", "user.email", "test@example.com"], cwd=path)
    git(["config", "user.name", "Cow Test"], cwd=path)
    git(["config", "commit.gpgsign", "false"], cwd=path)
    return path


def run_wrapper(
    seed,
    target,
    dest,
    dry_run=False,
    verbose=True,
    check=True,
    env=None,
    enable_test_hooks=False,
):
    """`enable_test_hooks=True` passes the wrapper's hidden
    `--enable-test-hooks` flag, without which every `COW_WORKTREE_TEST_*`
    environment variable in `env` is completely inert (see
    bin/cow_worktree.py's "Test-only injection hooks" section). Only tests
    that actually need a fault/adversarial injection hook should pass
    this."""
    _guard(seed)
    _guard(dest)
    args = [sys.executable, WRAPPER, "--seed", seed, "--target", target, "--dest", dest]
    if dry_run:
        args.append("--dry-run")
    if verbose:
        args.append("-v")
    if enable_test_hooks:
        args.append("--enable-test-hooks")
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=merged_env)
    if check and proc.returncode != 0:
        raise AssertionError(
            "wrapper failed unexpectedly:\n"
            f"stdout: {proc.stdout.decode(errors='replace')}\n"
            f"stderr: {proc.stderr.decode(errors='replace')}"
        )
    return proc


def rmtree_scratch(path):
    _guard(path)
    shutil.rmtree(path, ignore_errors=True)
