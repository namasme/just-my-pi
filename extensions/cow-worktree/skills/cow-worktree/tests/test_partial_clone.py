#!/usr/bin/env python3
"""Bounded local integration test for the partial/promisor (blobless)
seed-materialization preflight.

Builds a genuinely blobless local seed via `git clone --no-local
--filter=blob:none file://<origin>` (see `fixtures.build_promisor_seed`'s
docstring for why both `--no-local` and `uploadpack.allowfilter=true` are
required to get a real partial clone out of a `file://` origin -- a plain
local clone silently ignores the filter). The seed is checked out at
`main`; a local `feature` branch (not checked out anywhere) points at a
commit whose changed/added blobs are provably absent from the seed with
lazy fetching disabled (`GIT_NO_LAZY_FETCH=1`).

Two scenarios:

  * Happy path: the origin remains reachable. The wrapper's preflight
    step (`materialize_target_objects`) must fetch every blob the target
    tree needs *before* any worktree registration, and the resulting
    worktree must be correct.
  * Failure path: the origin is made unreachable (renamed away) after
    cloning but before the wrapper runs. The preflight fetch must fail,
    and that failure must happen strictly before any worktree
    registration or mutation -- no temporary worktree, no destination, no
    change to the seed's own single registered worktree.

Skips itself (rather than failing) if the local git/platform cannot
produce a genuine partial clone this way (e.g. an old git without
`--filter`/`uploadpack.allowfilter` support). See README's "Limitations"
for how this fixture differs from a real monorepo/pristine-monorepo
partial clone (single small repo, local `file://` origin forced through
the smart-protocol path, no real network latency or auth).
"""
import os
import shutil
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from helpers import git, new_scratch_dir, rmtree_scratch, run_wrapper
from fixtures import build_promisor_seed


def _missing_locally(seed, oid):
    import subprocess

    proc = subprocess.run(
        ["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
        cwd=seed,
        input=(oid + "\n").encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "GIT_NO_LAZY_FETCH": "1"},
    )
    return b"missing" in proc.stdout


def list_worktrees(repo):
    return git(["worktree", "list", "--porcelain"], cwd=repo).stdout.decode(errors="replace")


class BasePartialCloneCase(unittest.TestCase):
    def setUp(self):
        self.root = new_scratch_dir(self._testMethodName)
        self.addCleanup(rmtree_scratch, self.root)
        fixture = build_promisor_seed(self.root)
        if fixture is None:
            self.skipTest(
                "local git/platform did not produce a genuine blobless partial clone "
                "(old git, or a transport that ignores --filter even with --no-local)"
            )
        self.origin = fixture["origin"]
        self.seed = fixture["seed"]
        self.missing_blob = fixture["feature_missing_blob"]
        # Sanity re-check inside the test process too (belt and suspenders
        # against the fixture's own guarantee silently regressing).
        self.assertTrue(
            _missing_locally(self.seed, self.missing_blob),
            "fixture setup did not actually produce a missing target blob",
        )


class TestPartialCloneMaterialization(BasePartialCloneCase):
    def test_reachable_origin_materializes_before_registration_and_succeeds(self):
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(self.seed, "feature", dest, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode(errors="replace"))

        # Blob preflight-fetched: now present locally with lazy fetch
        # disabled.
        self.assertFalse(
            _missing_locally(self.seed, self.missing_blob),
            "target blob was not actually materialized into the seed's object store",
        )

        # Worktree content is correct.
        feature_tree = git(
            ["rev-parse", "feature^{tree}"], cwd=self.seed
        ).stdout.decode().strip()
        dest_tree = git(["write-tree"], cwd=dest).stdout.decode().strip()
        self.assertEqual(dest_tree, feature_tree)
        with open(os.path.join(dest, "data", "f0.txt")) as f:
            self.assertEqual(f.read(), "feature content 0 totally different\n")
        with open(os.path.join(dest, "data", "new.txt")) as f:
            self.assertEqual(f.read(), "brand new file on feature\n")

    def test_unreachable_origin_fails_before_any_registration(self):
        # Simulate a network/object-store failure: make the promisor
        # remote unreachable strictly between clone and wrapper run.
        moved_origin = self.origin + ".unreachable"
        os.rename(self.origin, moved_origin)
        self.addCleanup(lambda: os.path.exists(moved_origin) and os.rename(moved_origin, self.origin))

        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(self.seed, "feature", dest, check=False)

        self.assertNotEqual(proc.returncode, 0)
        stderr = proc.stderr.decode(errors="replace")
        self.assertIn("materialize", stderr)

        # Nothing was created or registered: the failure happened during
        # the network preflight, strictly before `reserve_tmp_path()` /
        # `git worktree add`.
        self.assertFalse(os.path.exists(dest))
        leftovers = [n for n in os.listdir(self.root) if n.startswith(".cow-wt-tmp.")]
        self.assertEqual(leftovers, [])
        self.assertEqual(list_worktrees(self.seed).count("worktree "), 1)

        # And the still-missing blob was never (partially) fetched either.
        self.assertTrue(_missing_locally(self.seed, self.missing_blob))


if __name__ == "__main__":
    unittest.main(verbosity=2)
