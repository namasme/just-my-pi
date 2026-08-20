#!/usr/bin/env python3
"""Synthetic same-commit benchmark for ordinary vs APFS-CoW worktrees.

All data stays under ../tests/_scratch/benchmark, and is removed again at
the end of the run (set COW_BENCH_KEEP=1 to inspect it afterwards). Physical
allocation is estimated from df available blocks and is inherently noisy on
a live APFS system (delayed reclamation can even make deltas negative);
logical allocated size is reported with du, which double-counts extents
shared between the two trees rather than showing storage savings. Each
measurement is a single sample (not averaged/repeated), and the two runs
share a process/page-cache warm-up order (ordinary always runs first), so
treat the timing numbers as illustrative, not a rigorous benchmark.
"""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
ROOT = LAB / "tests" / "_scratch" / "benchmark"
REPO = ROOT / "repo"
WRAPPER = LAB / "bin" / "cow_worktree.py"
FILE_COUNT = int(os.environ.get("COW_BENCH_FILES", "10000"))
FILE_SIZE = int(os.environ.get("COW_BENCH_FILE_SIZE", "8192"))


def run(args, cwd=None, capture=False):
    return subprocess.run(
        [str(a) for a in args], cwd=cwd, check=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def available_bytes(path):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


def du_kib(path):
    out = subprocess.check_output(["du", "-sk", str(path)], text=True)
    return int(out.split()[0])


def measure(label, command, dest):
    before = available_bytes(ROOT)
    t0 = time.perf_counter()
    run(command)
    elapsed = time.perf_counter() - t0
    run(["sync"])
    time.sleep(1)
    after = available_bytes(ROOT)
    logical = du_kib(dest)
    print(
        f"{label}\tseconds={elapsed:.3f}\tdu_mib={logical/1024:.1f}"
        f"\tcontainer_delta_mib={(before-after)/1024/1024:.1f}",
        flush=True,
    )
    return elapsed, logical, before - after


def main():
    if ROOT.exists():
        shutil.rmtree(ROOT)
    REPO.mkdir(parents=True)
    run(["git", "init", "-q", "-b", "main"], cwd=REPO)
    run(["git", "config", "user.name", "Benchmark"], cwd=REPO)
    run(["git", "config", "user.email", "benchmark@example.com"], cwd=REPO)
    data = REPO / "data"
    data.mkdir()
    print(f"creating {FILE_COUNT} files x {FILE_SIZE} bytes", flush=True)
    # Unique deterministic-ish payloads avoid unrealistic compression while
    # keeping setup straightforward. The benchmark is disposable.
    for i in range(FILE_COUNT):
        payload = os.urandom(FILE_SIZE)
        (data / f"file-{i:06d}.bin").write_bytes(payload)
    run(["git", "add", "data"], cwd=REPO)
    run(["git", "commit", "-qm", "benchmark seed"], cwd=REPO)
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()

    normal = ROOT / "normal"
    cow = ROOT / "cow"
    normal_result = measure(
        "ordinary",
        ["git", "-C", REPO, "worktree", "add", "-q", "--detach", normal, sha],
        normal,
    )
    run(["git", "-C", REPO, "worktree", "remove", "--force", normal])
    run(["sync"]); time.sleep(2)

    cow_result = measure(
        "cow",
        [sys.executable, WRAPPER, "--seed", REPO, "--target", sha, "--dest", cow],
        cow,
    )
    print(f"speedup={normal_result[0]/cow_result[0]:.2f}x")
    print("Note: du counts shared extents in each tree; APFS free-space deltas are noisy.")

    if os.environ.get("COW_BENCH_KEEP") == "1":
        print(f"COW_BENCH_KEEP=1: leaving benchmark data at {ROOT}", flush=True)
    else:
        shutil.rmtree(ROOT, ignore_errors=True)
        print(f"removed disposable benchmark data at {ROOT}", flush=True)


if __name__ == "__main__":
    main()
