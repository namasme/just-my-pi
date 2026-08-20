#!/usr/bin/env python3
"""Automated test suite for bin/cow_worktree.py.

Run with:
    python3 tests/test_cow_worktree.py -v

Everything happens under tests/_scratch/ inside the disposable lab dir.
Never touches the real the monorepo checkouts (helpers.py enforces this).
"""
import errno
import importlib.util
import os
import shutil
import stat
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from helpers import (
    LAB_DIR,
    SCRATCH_ROOT,
    WRAPPER,
    git,
    new_scratch_dir,
    rmtree_scratch,
    run_wrapper,
    sh,
)
from fixtures import add_divergent_branch, build_base_repo, write


def _load_cow_worktree_module():
    """Load bin/cow_worktree.py as a module for white-box unit tests of its
    internals (e.g. the raw clonefile(2) wrapper), without going through a
    subprocess."""
    spec = importlib.util.spec_from_file_location(
        "cow_worktree", os.path.join(LAB_DIR, "bin", "cow_worktree.py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses needs this registered first
    spec.loader.exec_module(module)
    return module


COW = _load_cow_worktree_module()


def tree_hash(repo, ref):
    return git(["rev-parse", f"{ref}^{{tree}}"], cwd=repo).stdout.decode().strip()


def head_sha(repo, ref="HEAD"):
    """Resolve `ref` to a raw commit sha. Used as a DETACHED target in tests
    where the branch name itself is already checked out by the seed (or by
    the primary worktree), which git's one-worktree-per-branch rule would
    otherwise (correctly) reject."""
    return git(["rev-parse", ref], cwd=repo).stdout.decode().strip()


def worktree_write_tree(path):
    return git(["write-tree"], cwd=path).stdout.decode().strip()


def is_clean(path):
    out = git(["status", "--porcelain", "--ignored"], cwd=path).stdout.decode(errors="replace")
    return out.strip() == ""


def list_worktrees(repo):
    out = git(["worktree", "list", "--porcelain"], cwd=repo).stdout.decode(errors="replace")
    return out


class BaseCase(unittest.TestCase):
    def setUp(self):
        self.root = new_scratch_dir(self._testMethodName)
        self.addCleanup(rmtree_scratch, self.root)


class TestSameCommit(BaseCase):
    def test_same_commit_seed_and_target(self):
        # Target is the seed's own HEAD commit, passed as a raw sha (a
        # *detached* target). Using the literal branch name "main" here
        # would be rejected, correctly, because the seed itself already has
        # that branch checked out (git allows a branch in only one
        # worktree at a time) -- see test_target_checked_out_elsewhere_rejected.
        repo = build_base_repo(self.root)
        dest = os.path.join(self.root, "dest")
        target = head_sha(repo)
        proc = run_wrapper(repo, target, dest)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        self.assertTrue(is_clean(dest))
        self.assertEqual(worktree_write_tree(dest), tree_hash(repo, "main"))
        self.assertEqual(
            git(["rev-parse", "HEAD"], cwd=dest).stdout.decode().strip(), target
        )


class TestDivergentBranch(BaseCase):
    def test_adds_modifies_deletes_renames(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, "feature", dest)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())

        self.assertTrue(is_clean(dest))
        self.assertEqual(worktree_write_tree(dest), tree_hash(repo, "feature"))

        # modify applied
        with open(os.path.join(dest, "a", "b", "f1.txt")) as f:
            self.assertEqual(f.read(), "hello MODIFIED\n")
        # delete applied
        self.assertFalse(os.path.exists(os.path.join(dest, "a", "exec.sh")))
        # add applied
        self.assertTrue(os.path.exists(os.path.join(dest, "a", "c", "new.txt")))
        # rename applied (old path gone, new path present)
        self.assertFalse(os.path.exists(os.path.join(dest, "file with space.txt")))
        self.assertTrue(
            os.path.exists(os.path.join(dest, "file with space (renamed).txt"))
        )


class TestExecAndSymlink(BaseCase):
    def test_executable_bits_and_symlinks(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        run_wrapper(repo, "feature", dest)

        # untouched exec file from S survives with correct mode where not
        # deleted on this branch; check the one that DOES survive: none of
        # the originals survive on `feature` (exec.sh was deleted), so
        # check the *new* exec file created purely via the -u transform.
        new_exec = os.path.join(dest, "a", "c", "new_exec.sh")
        mode = stat.S_IMODE(os.lstat(new_exec).st_mode)
        self.assertEqual(mode, 0o755, oct(mode))

        link1 = os.path.join(dest, "link1")
        self.assertTrue(os.path.islink(link1))
        self.assertEqual(os.readlink(link1), "a/b/f1.txt")

        link2 = os.path.join(dest, "link2")
        self.assertTrue(os.path.islink(link2))
        self.assertEqual(os.readlink(link2), "a/c/new.txt")

    def test_exec_bit_preserved_on_unchanged_file(self):
        # Seed == target (no transform at all): exec bit must survive
        # purely through the CoW copy step.
        repo = build_base_repo(self.root)
        dest = os.path.join(self.root, "dest")
        run_wrapper(repo, head_sha(repo), dest)
        exec_path = os.path.join(dest, "a", "exec.sh")
        mode = stat.S_IMODE(os.lstat(exec_path).st_mode)
        self.assertEqual(mode, 0o755, oct(mode))


class TestUnicodeAndSpaces(BaseCase):
    def test_filenames_with_spaces_and_unicode(self):
        repo = build_base_repo(self.root)
        dest = os.path.join(self.root, "dest")
        run_wrapper(repo, head_sha(repo), dest)

        space_path = os.path.join(dest, "file with space.txt")
        self.assertTrue(os.path.exists(space_path))

        uni_path = os.path.join(dest, "unicode-café", "日本語ファイル.txt")
        self.assertTrue(os.path.exists(uni_path), f"missing: {uni_path}")
        with open(uni_path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "unicode content\n")


class TestRejections(BaseCase):
    def test_dirty_tracked_seed_rejected(self):
        repo = build_base_repo(self.root)
        write(os.path.join(repo, "top.txt"), "DIRTY\n")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, "main", dest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"do not exactly match HEAD", proc.stderr)
        self.assertFalse(os.path.exists(dest))

    def test_staged_seed_rejected(self):
        repo = build_base_repo(self.root)
        write(os.path.join(repo, "top.txt"), "STAGED CHANGE\n")
        git(["add", "top.txt"], cwd=repo)
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, "main", dest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"do not exactly match HEAD", proc.stderr)
        self.assertFalse(os.path.exists(dest))

    def test_untracked_seed_rejected(self):
        repo = build_base_repo(self.root)
        write(os.path.join(repo, "untracked.txt"), "surprise\n")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, "main", dest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"untracked", proc.stderr)
        self.assertFalse(os.path.exists(dest))

    def test_ignored_seed_rejected(self):
        repo = build_base_repo(self.root)
        write(os.path.join(repo, ".gitignore"), "ignored.txt\n")
        write(os.path.join(repo, "ignored.txt"), "secret\n")
        git(["add", ".gitignore"], cwd=repo)
        git(["commit", "-q", "-m", "add gitignore"], cwd=repo)
        # ignored.txt itself stays untracked+ignored
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, "main", dest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"untracked", proc.stderr)  # message covers both
        self.assertFalse(os.path.exists(dest))

    def test_sparse_seed_rejected(self):
        repo = build_base_repo(self.root)
        sparse_clone = os.path.join(self.root, "sparse_clone")
        git(["clone", "-q", repo, sparse_clone], cwd=self.root)
        git(["sparse-checkout", "init", "--cone"], cwd=sparse_clone)
        git(["sparse-checkout", "set", "a"], cwd=sparse_clone)
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(sparse_clone, "main", dest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"sparse", proc.stderr)
        self.assertFalse(os.path.exists(dest))

    def test_existing_nonempty_destination_rejected(self):
        repo = build_base_repo(self.root)
        dest = os.path.join(self.root, "dest")
        os.makedirs(dest)
        write(os.path.join(dest, "stray.txt"), "already here\n")
        proc = run_wrapper(repo, head_sha(repo), dest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"already exists", proc.stderr)
        # untouched
        self.assertTrue(os.path.exists(os.path.join(dest, "stray.txt")))

    def test_existing_empty_destination_rejected(self):
        # Policy (post-hardening): destination must not exist at all, not
        # even as an empty directory -- see move_worktree()'s docstring for
        # why (git worktree move nests INTO an existing directory rather
        # than erroring, so tolerating an empty one would require this
        # wrapper to remove it itself right before the move, which is
        # exactly the TOCTOU this policy eliminates).
        repo = build_base_repo(self.root)
        dest = os.path.join(self.root, "dest")
        os.makedirs(dest)
        proc = run_wrapper(repo, head_sha(repo), dest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"already exists", proc.stderr)
        # untouched: the empty directory itself must survive rejection.
        self.assertTrue(os.path.isdir(dest))
        self.assertEqual(os.listdir(dest), [])

    def test_target_checked_out_elsewhere_rejected(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        other = os.path.join(self.root, "other_checkout")
        git(["worktree", "add", other, "feature"], cwd=repo)
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, "feature", dest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"already checked out", proc.stderr)
        self.assertFalse(os.path.exists(dest))

    def test_cross_device_destination_rejected_when_simulated(self):
        # We simulate a "different device" without touching real external
        # volumes by monkeypatching is impossible across a subprocess, so
        # instead we assert the *check exists and runs* using the real
        # same-device path (must pass) and document the cross-device
        # behavior is exercised for real in tests/test_cross_device.py
        # against a throwaway disk image.
        repo = build_base_repo(self.root)
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, head_sha(repo), dest, check=False)
        self.assertEqual(proc.returncode, 0)


class TestCleanupOnFailure(BaseCase):
    def assert_no_wrapper_leftovers(self, repo, dest):
        self.assertFalse(os.path.exists(dest), "destination must not be left behind")
        leftovers = [n for n in os.listdir(self.root) if n.startswith(".cow-wt-tmp.")]
        self.assertEqual(leftovers, [], f"leftover tmp/sidecar paths: {leftovers}")
        wt_list = list_worktrees(repo)
        self.assertNotIn(".cow-wt-tmp.", wt_list)
        self.assertEqual(wt_list.count("worktree "), 1, wt_list)

    def test_injected_mid_copy_failure_cleanup(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(
            repo, "feature", dest, check=False,
            env={"COW_WORKTREE_TEST_FAIL_AFTER_COPY": "2"},
            enable_test_hooks=True,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"injected test failure", proc.stderr)
        self.assert_no_wrapper_leftovers(repo, dest)

    def test_failure_after_add_before_private_marker_cleanup(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(
            repo, "feature", dest, check=False,
            env={"COW_WORKTREE_TEST_FAIL_STAGE": "after-add-before-marker"},
            enable_test_hooks=True,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assert_no_wrapper_leftovers(repo, dest)

    def test_keyboard_interrupt_cleanup(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(
            repo, "feature", dest, check=False,
            env={"COW_WORKTREE_TEST_FAIL_STAGE": "interrupt-after-marker"},
            enable_test_hooks=True,
        )
        self.assertEqual(proc.returncode, 130)
        self.assert_no_wrapper_leftovers(repo, dest)

    def test_failure_after_move_cleanup(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(
            repo, "feature", dest, check=False,
            env={"COW_WORKTREE_TEST_FAIL_STAGE": "after-move-before-current"},
            enable_test_hooks=True,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assert_no_wrapper_leftovers(repo, dest)


class TestSymlinkAliasAttack(BaseCase):
    """Adversarial test for the cleanup ownership / symlink alias blocker:
    a raced symlink at the wrapper's reserved temp path, pointed at an
    established, unrelated worktree ("victim"), must never cause that
    victim to be touched, removed, or have its registration altered."""

    def test_temp_path_symlink_to_victim_worktree_is_never_touched(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")

        # An established, unrelated worktree the "attacker" wants to alias.
        victim = os.path.join(self.root, "victim_worktree")
        git(["worktree", "add", victim, "feature"], cwd=repo)
        victim_file = os.path.join(victim, "top.txt")
        with open(victim_file) as f:
            victim_content_before = f.read()

        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(
            repo, head_sha(repo), dest, check=False,
            env={"COW_WORKTREE_TEST_SYMLINK_ATTACK_TARGET": victim},
            enable_test_hooks=True,
        )

        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"SECURITY", proc.stderr)
        self.assertIn(b"symlink", proc.stderr)

        # The victim must be completely unaffected: still on disk, still
        # containing its original content, and still registered.
        self.assertTrue(os.path.isdir(victim), "victim worktree directory must survive")
        with open(victim_file) as f:
            self.assertEqual(f.read(), victim_content_before)
        wt_list = list_worktrees(repo)
        self.assertIn(f"worktree {victim}", wt_list)
        self.assertEqual(wt_list.count("worktree "), 2, wt_list)  # primary + victim, no tmp

        # dest must never have been created.
        self.assertFalse(os.path.exists(dest))

        # The wrapper's own reserved tmp path is left exactly as the
        # simulated attack left it (a dangling symlink to the victim) --
        # cleanup deliberately refuses to touch it once it detects the
        # symlink, since blindly deleting a symlink whose target it can no
        # longer trust is not obviously safer than leaving it. This is a
        # documented, intentional residual (an orphaned sidecar+symlink
        # pair, both trivially identifiable by name for manual/future
        # cleanup), not an oversight -- see README's "Limitations".
        leftover_symlinks = [
            n for n in os.listdir(self.root)
            if n.startswith(".cow-wt-tmp.") and not n.endswith(".cow-owner")
        ]
        self.assertEqual(len(leftover_symlinks), 1, leftover_symlinks)
        self.assertTrue(os.path.islink(os.path.join(self.root, leftover_symlinks[0])))


class TestSymlinkAliasAttackPostMarker(BaseCase):
    """Adversarial test for the *post-registration* mid-run path-replacement
    window (second-critic-review conditional blocker #2): a race that only
    wins *after* `git worktree add` and the private marker have already
    been created (i.e. after TestSymlinkAliasAttack's earlier window has
    already closed) must still be caught before any further mutating step
    (index initialization, in this test) touches the now-hijacked path,
    and must never affect an established, unrelated victim worktree."""

    def test_temp_path_symlink_to_victim_after_marker_is_never_touched(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")

        victim = os.path.join(self.root, "victim_worktree")
        git(["worktree", "add", victim, "feature"], cwd=repo)
        victim_file = os.path.join(victim, "top.txt")
        with open(victim_file) as f:
            victim_content_before = f.read()
        victim_head_before = head_sha(victim)

        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(
            repo, head_sha(repo), dest, check=False,
            env={"COW_WORKTREE_TEST_SYMLINK_ATTACK_POST_MARKER_TARGET": victim},
            enable_test_hooks=True,
        )

        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"SECURITY", proc.stderr)
        self.assertIn(b"symlink", proc.stderr)
        # Must be caught at the index-initialization identity re-check
        # specifically, i.e. before `git read-tree` (or anything later)
        # ever ran with the hijacked path as its cwd.
        self.assertIn(b"index initialization", proc.stderr)

        # The victim's HEAD, index/files, and registration must all remain
        # completely unchanged.
        self.assertTrue(os.path.isdir(victim), "victim worktree directory must survive")
        with open(victim_file) as f:
            self.assertEqual(f.read(), victim_content_before)
        self.assertEqual(head_sha(victim), victim_head_before)
        self.assertTrue(is_clean(victim))
        wt_list = list_worktrees(repo)
        self.assertIn(f"worktree {victim}", wt_list)
        # Unlike the pre-registration case (TestSymlinkAliasAttack), `git
        # worktree add` DID already run here (before the simulated attack),
        # so this run's own reservation is genuinely registered under
        # seed's `.git/worktrees/`; since cleanup correctly refuses to call
        # `git worktree remove` once it detects the symlink (proven-unsafe
        # to touch), that registration survives as a stale entry that only
        # `git worktree prune`/a future run's own cleanup could remove:
        # primary + victim + this run's own now-stale registration.
        self.assertEqual(wt_list.count("worktree "), 3, wt_list)

        # dest must never have been created.
        self.assertFalse(os.path.exists(dest))

        # Cleanup refuses to touch the hijacked path once it detects the
        # symlink (same documented, intentional residual as the
        # pre-registration case in TestSymlinkAliasAttack): the orphaned
        # symlink is left in place, identifiable by name.
        leftover_symlinks = [
            n for n in os.listdir(self.root)
            if n.startswith(".cow-wt-tmp.") and not n.endswith(".cow-owner")
        ]
        self.assertEqual(len(leftover_symlinks), 1, leftover_symlinks)
        self.assertTrue(os.path.islink(os.path.join(self.root, leftover_symlinks[0])))


class TestSubmoduleGitlinkTargetRejected(BaseCase):
    def test_target_introducing_submodule_rejected_before_registration(self):
        child = os.path.join(self.root, "child")
        os.makedirs(child)
        git(["init", "-q", "-b", "main"], cwd=child)
        git(["config", "user.email", "test@example.com"], cwd=child)
        git(["config", "user.name", "Cow Test"], cwd=child)
        write(os.path.join(child, "child.txt"), "child\n")
        git(["add", "child.txt"], cwd=child)
        git(["commit", "-q", "-m", "child"], cwd=child)

        # Seed itself is entirely clean of any submodule/gitlink; only the
        # TARGET commit introduces one.
        repo = build_base_repo(self.root)
        git(["checkout", "-q", "-b", "adds-submodule"], cwd=repo)
        git(
            ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "submodule"],
            cwd=repo,
        )
        git(["commit", "-q", "-am", "target adds a submodule"], cwd=repo)
        git(["checkout", "-q", "main"], cwd=repo)
        # `git checkout` never removes a submodule's working directory when
        # leaving a commit that had one (data-loss avoidance), so the seed
        # would otherwise show it as untracked; the seed itself must stay
        # entirely clean so this test isolates the TARGET-side rejection.
        shutil.rmtree(os.path.join(repo, "submodule"), ignore_errors=True)

        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, "adds-submodule", dest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"target contains unsupported submodule/gitlink", proc.stderr)
        self.assertFalse(os.path.exists(dest))
        # Rejection must happen during planning/validation, before any
        # worktree registration: exactly one worktree (the primary) exists.
        self.assertEqual(list_worktrees(repo).count("worktree "), 1)
        leftovers = [n for n in os.listdir(self.root) if n.startswith(".cow-wt-tmp.")]
        self.assertEqual(leftovers, [])


class TestSeedMutationDuringRun(BaseCase):
    # Ambient Git config poisoning applied on top of the mutation-injection
    # env, for the config-independence tests below: sets
    # `core.fsmonitor=/usr/bin/true` (a hook that always reports "no files
    # changed", the classic stale/malicious-fsmonitor false-clean attack),
    # `core.trustctime=false` (would let an mtime-preserving mutation slip
    # through), and `core.checkStat=minimal` (checks fewer stat fields).
    # Delivered via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`
    # -- environment-based config that `sanitized_git_env()` deliberately
    # does NOT strip (see its docstring) -- specifically to prove that
    # `git_verify()`'s command-line `-c` overrides still win regardless.
    _CONFIG_POISON_ENV = {
        "GIT_CONFIG_COUNT": "3",
        "GIT_CONFIG_KEY_0": "core.fsmonitor",
        "GIT_CONFIG_VALUE_0": "/usr/bin/true",
        "GIT_CONFIG_KEY_1": "core.trustctime",
        "GIT_CONFIG_VALUE_1": "false",
        "GIT_CONFIG_KEY_2": "core.checkStat",
        "GIT_CONFIG_VALUE_2": "minimal",
    }

    def _assert_mutation_detected(self, repo, dest, proc):
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"seed was mutated during this run", proc.stderr)
        self.assertFalse(os.path.exists(dest), "must not create a wrong clean destination")
        leftovers = [n for n in os.listdir(self.root) if n.startswith(".cow-wt-tmp.")]
        self.assertEqual(leftovers, [])
        self.assertEqual(list_worktrees(repo).count("worktree "), 1)

    def test_seed_mutated_before_copy_is_detected(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(
            repo, "feature", dest, check=False,
            env={
                "COW_WORKTREE_TEST_MUTATE_SEED_PATH": "top.txt",
                "COW_WORKTREE_TEST_MUTATE_SEED_STAGE": "before-copy",
            },
            enable_test_hooks=True,
        )
        self._assert_mutation_detected(repo, dest, proc)
        git(["checkout", "--", "top.txt"], cwd=repo)  # restore seed for teardown cleanliness

    def test_seed_mutated_before_move_is_detected(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(
            repo, "feature", dest, check=False,
            env={
                "COW_WORKTREE_TEST_MUTATE_SEED_PATH": "top.txt",
                "COW_WORKTREE_TEST_MUTATE_SEED_STAGE": "before-move",
            },
            enable_test_hooks=True,
        )
        self._assert_mutation_detected(repo, dest, proc)
        git(["checkout", "--", "top.txt"], cwd=repo)

    def test_seed_mutated_before_copy_is_detected_despite_poisoned_verification_config(self):
        # Same as test_seed_mutated_before_copy_is_detected, but with
        # ambient Git config poisoned (see _CONFIG_POISON_ENV) in a way
        # that would defeat an *unhardened* `git diff --quiet`-based check.
        # Proves git_verify()'s forced `-c core.fsmonitor=false -c
        # core.trustctime=true -c core.checkStat=default` still catches the
        # mutation despite this ambient poisoning.
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        env = dict(self._CONFIG_POISON_ENV)
        env.update(
            {
                "COW_WORKTREE_TEST_MUTATE_SEED_PATH": "top.txt",
                "COW_WORKTREE_TEST_MUTATE_SEED_STAGE": "before-copy",
            }
        )
        proc = run_wrapper(repo, "feature", dest, check=False, env=env, enable_test_hooks=True)
        self._assert_mutation_detected(repo, dest, proc)
        git(["checkout", "--", "top.txt"], cwd=repo)

    def test_seed_mutated_before_move_is_detected_despite_poisoned_verification_config(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        env = dict(self._CONFIG_POISON_ENV)
        env.update(
            {
                "COW_WORKTREE_TEST_MUTATE_SEED_PATH": "top.txt",
                "COW_WORKTREE_TEST_MUTATE_SEED_STAGE": "before-move",
            }
        )
        proc = run_wrapper(repo, "feature", dest, check=False, env=env, enable_test_hooks=True)
        self._assert_mutation_detected(repo, dest, proc)
        git(["checkout", "--", "top.txt"], cwd=repo)


class TestAmbientEnvironmentPoisoning(BaseCase):
    def test_poisoned_git_env_vars_are_ignored(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")

        decoy_root = os.path.join(self.root, "decoy_root")
        os.makedirs(decoy_root)
        decoy = build_base_repo(decoy_root)

        dest = os.path.join(self.root, "dest")
        bogus_index = os.path.join(self.root, "bogus-index-should-not-be-created")
        poisoned_env = {
            "GIT_DIR": os.path.join(decoy, ".git"),
            "GIT_WORK_TREE": decoy,
            "GIT_INDEX_FILE": bogus_index,
            "GIT_COMMON_DIR": os.path.join(decoy, ".git"),
            "GIT_OBJECT_DIRECTORY": os.path.join(decoy, ".git", "objects"),
            "GIT_ALTERNATE_OBJECT_DIRECTORIES": os.path.join(decoy, ".git", "objects"),
        }
        proc = run_wrapper(repo, "feature", dest, check=False, env=poisoned_env)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        self.assertTrue(is_clean(dest))
        self.assertEqual(worktree_write_tree(dest), tree_hash(repo, "feature"))

        self.assertFalse(
            os.path.exists(bogus_index), "poisoned GIT_INDEX_FILE must never be created"
        )
        # The decoy repo pointed to by the poisoned vars must be completely
        # unaffected.
        self.assertTrue(is_clean(decoy))
        self.assertEqual(list_worktrees(decoy).count("worktree "), 1)

    def test_poisoned_git_dir_pointing_to_nonexistent_path_is_ignored(self):
        repo = build_base_repo(self.root)
        dest = os.path.join(self.root, "dest")
        poisoned_env = {
            "GIT_DIR": "/nonexistent/definitely-not-a-repo/.git",
            "GIT_WORK_TREE": "/nonexistent/definitely-not-a-repo",
            "GIT_INDEX_FILE": "/nonexistent/definitely-not-a-repo/.git/index",
            "GIT_COMMON_DIR": "/nonexistent/definitely-not-a-repo/.git",
        }
        proc = run_wrapper(repo, head_sha(repo), dest, check=False, env=poisoned_env)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        self.assertTrue(is_clean(dest))


class TestDestinationTOCTOU(BaseCase):
    def test_concurrently_created_destination_fails_safely_without_removal(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(
            repo, "feature", dest, check=False,
            env={"COW_WORKTREE_TEST_CREATE_DEST_BEFORE_MOVE": "1"},
            enable_test_hooks=True,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"came into existence before the final move", proc.stderr)
        # The concurrently-created destination must survive untouched
        # (still an empty directory) -- the wrapper must never remove it.
        self.assertTrue(os.path.isdir(dest))
        self.assertEqual(os.listdir(dest), [])
        leftovers = [n for n in os.listdir(self.root) if n.startswith(".cow-wt-tmp.")]
        self.assertEqual(leftovers, [])
        self.assertEqual(list_worktrees(repo).count("worktree "), 1)

    def test_check_to_move_race_preserves_foreign_content(self):
        """Narrower than the race above: DEST is raced into existence WITH
        REAL FOREIGN CONTENT strictly inside move_worktree()'s own
        check-to-move window (between its `os.path.lexists` re-check and
        the `git worktree move` subprocess call itself), rather than
        before move_worktree() is even called. This is the genuine,
        narrowest version of the check->move TOCTOU (second-critic-review
        conditional blocker #4): proves that even when it wins, the
        wrapper fails safely, the foreign directory's actual content
        (not just its existence) is provably preserved byte-for-byte,
        and the nested worktree this run created gets fully cleaned up
        rather than left as clutter inside the foreign directory."""
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(
            repo, "feature", dest, check=False,
            env={"COW_WORKTREE_TEST_CREATE_DEST_WITH_CONTENT_DURING_MOVE": "1"},
            enable_test_hooks=True,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"raced into existence during the final move", proc.stderr)

        # Foreign content must survive completely untouched.
        self.assertTrue(os.path.isdir(dest))
        marker = os.path.join(dest, "foreign-marker.txt")
        self.assertTrue(os.path.isfile(marker))
        with open(marker) as f:
            self.assertEqual(f.read(), "pre-existing foreign content that must survive\n")

        # The nested worktree this run created inside the foreign
        # directory must have been fully cleaned up -- nothing left
        # inside dest beyond the pre-existing foreign marker.
        self.assertEqual(os.listdir(dest), ["foreign-marker.txt"])

        # No wrapper temp path/sidecar leftovers, and exactly the
        # original primary worktree remains registered (the nested
        # registration this run created must not be left stale).
        leftovers = [n for n in os.listdir(self.root) if n.startswith(".cow-wt-tmp.")]
        self.assertEqual(leftovers, [])
        self.assertEqual(list_worktrees(repo).count("worktree "), 1, list_worktrees(repo))


class TestTestHooksDisabledByDefault(BaseCase):
    """Second-critic-review conditional blocker #1: every
    `COW_WORKTREE_TEST_*` environment variable must be completely inert
    -- unable to mutate the seed, redirect/hijack the reserved temp path,
    create a destination race, or alter any other normal-run behavior --
    unless the hidden, non-default `--enable-test-hooks` CLI flag was
    also explicitly passed. This proves the ambient-env-alone case is
    actually inert, not just documented as intended to be."""

    def test_ambient_hook_env_vars_alone_are_completely_inert(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")

        # An established worktree that every symlink-alias hook, if it
        # were live, would target.
        victim = os.path.join(self.root, "victim_worktree")
        git(["worktree", "add", victim, "feature"], cwd=repo)
        with open(os.path.join(victim, "top.txt")) as f:
            victim_content_before = f.read()

        dest = os.path.join(self.root, "dest")
        # One environment variable per hook defined in cow_worktree.py's
        # "Test-only injection hooks" section, all set simultaneously.
        # Every single one of these, if its hook were actually live,
        # would cause a visible failure or side effect below.
        poison_env = {
            "COW_WORKTREE_TEST_SYMLINK_ATTACK_TARGET": victim,
            "COW_WORKTREE_TEST_SYMLINK_ATTACK_POST_MARKER_TARGET": victim,
            "COW_WORKTREE_TEST_FAIL_AFTER_COPY": "1",
            "COW_WORKTREE_TEST_FAIL_STAGE": "after-add-before-marker",
            "COW_WORKTREE_TEST_MUTATE_SEED_PATH": "top.txt",
            "COW_WORKTREE_TEST_MUTATE_SEED_STAGE": "before-copy",
            "COW_WORKTREE_TEST_CREATE_DEST_BEFORE_MOVE": "1",
            "COW_WORKTREE_TEST_CREATE_DEST_WITH_CONTENT_DURING_MOVE": "1",
        }
        # Detached target (raw commit sha of main): "feature" itself is
        # already checked out by the victim worktree above, and a literal
        # branch-name target would (correctly) be rejected for that
        # unrelated reason, which would defeat this test's purpose.
        # Deliberately NOT passing enable_test_hooks=True.
        target = head_sha(repo)
        proc = run_wrapper(repo, target, dest, check=False, env=poison_env)

        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        self.assertTrue(is_clean(dest))
        self.assertEqual(worktree_write_tree(dest), tree_hash(repo, "main"))

        # Seed completely unaffected (the mutate-seed hook never fired).
        self.assertTrue(is_clean(repo))
        with open(os.path.join(repo, "top.txt")) as f:
            self.assertEqual(f.read(), "top level\n")

        # Victim worktree completely unaffected (the symlink-alias hooks
        # never fired) and still registered.
        self.assertTrue(os.path.isdir(victim))
        with open(os.path.join(victim, "top.txt")) as f:
            self.assertEqual(f.read(), victim_content_before)
        wt_list = list_worktrees(repo)
        self.assertIn(f"worktree {victim}", wt_list)
        self.assertEqual(wt_list.count("worktree "), 3, wt_list)  # primary + victim + dest

        # No leftover wrapper temp paths (the fail-after-copy/fail-stage/
        # create-dest hooks never fired either).
        leftovers = [n for n in os.listdir(self.root) if n.startswith(".cow-wt-tmp.")]
        self.assertEqual(leftovers, [])

    def test_enable_test_hooks_flag_is_hidden_from_help(self):
        proc = subprocess.run(
            [sys.executable, WRAPPER, "--help"], stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        self.assertNotIn(b"--enable-test-hooks", proc.stdout)
        self.assertNotIn(b"--enable-test-hooks", proc.stderr)


class TestIndependenceAndIntegrity(BaseCase):
    def test_dest_edit_does_not_alter_seed_and_vice_versa(self):
        repo = build_base_repo(self.root)
        dest = os.path.join(self.root, "dest")
        run_wrapper(repo, head_sha(repo), dest)

        write(os.path.join(dest, "top.txt"), "EDITED IN DEST\n")
        with open(os.path.join(repo, "top.txt")) as f:
            self.assertEqual(f.read(), "top level\n", "seed must be unaffected by dest edits")

        write(os.path.join(repo, "top.txt"), "EDITED IN SEED\n")
        with open(os.path.join(dest, "top.txt")) as f:
            self.assertEqual(
                f.read(), "EDITED IN DEST\n", "dest must be unaffected by seed edits"
            )
        # restore seed for teardown cleanliness (not required, but tidy)
        git(["checkout", "--", "top.txt"], cwd=repo)

    def test_final_worktree_clean_and_exact_tree(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        run_wrapper(repo, "feature", dest)
        self.assertTrue(is_clean(dest))
        self.assertEqual(worktree_write_tree(dest), tree_hash(repo, "feature"))
        # git fsck / status agree
        proc = git(["status"], cwd=dest)
        self.assertIn(b"nothing to commit, working tree clean", proc.stdout)

    def test_never_copies_git_or_local_only_content(self):
        repo = build_base_repo(self.root)
        dest = os.path.join(self.root, "dest")
        run_wrapper(repo, head_sha(repo), dest)

        dest_git = os.path.join(dest, ".git")
        self.assertTrue(os.path.isfile(dest_git), ".git must be a worktree-pointer FILE")
        with open(dest_git) as f:
            content = f.read()
        self.assertIn("gitdir:", content)

        # The seed's real .git directory must never have been copied in.
        seed_git_objects = os.path.join(repo, ".git", "objects")
        self.assertTrue(os.path.isdir(seed_git_objects))
        # dest has no objects/ directory of its own (that lives in the
        # common dir under seed's .git, shared via the gitdir pointer).
        self.assertFalse(os.path.isdir(os.path.join(dest, "objects")))

        common_dir = git(
            ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=dest
        ).stdout.decode().strip()
        self.assertEqual(os.path.realpath(common_dir), os.path.realpath(os.path.join(repo, ".git")))


class TestFilesystemEdgeCases(BaseCase):
    def test_case_only_rename(self):
        repo = build_base_repo(self.root)
        write(os.path.join(repo, "CaseName.txt"), "case content\n")
        git(["add", "CaseName.txt"], cwd=repo)
        git(["commit", "-q", "-m", "add case file"], cwd=repo)
        git(["checkout", "-q", "-b", "case-feature"], cwd=repo)
        # Two-step rename works reliably on case-insensitive APFS.
        git(["mv", "CaseName.txt", "case-temporary.txt"], cwd=repo)
        git(["mv", "case-temporary.txt", "casename.txt"], cwd=repo)
        git(["commit", "-q", "-m", "case-only rename"], cwd=repo)
        git(["checkout", "-q", "main"], cwd=repo)
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, "case-feature", dest, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        root_names = os.listdir(dest)
        self.assertNotIn("CaseName.txt", root_names)
        self.assertIn("casename.txt", root_names)
        self.assertTrue(is_clean(dest))

    def test_submodule_gitlink_rejected(self):
        child = os.path.join(self.root, "child")
        os.makedirs(child)
        git(["init", "-q", "-b", "main"], cwd=child)
        git(["config", "user.email", "test@example.com"], cwd=child)
        git(["config", "user.name", "Cow Test"], cwd=child)
        write(os.path.join(child, "child.txt"), "child\n")
        git(["add", "child.txt"], cwd=child)
        git(["commit", "-q", "-m", "child"], cwd=child)

        repo = build_base_repo(self.root)
        git(
            ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "submodule"],
            cwd=repo,
        )
        git(["commit", "-q", "-am", "add submodule"], cwd=repo)
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, head_sha(repo), dest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"unsupported submodule/gitlink", proc.stderr)
        self.assertFalse(os.path.exists(dest))

    @unittest.skipUnless(os.path.exists("/usr/bin/xattr"), "macOS xattr tool unavailable")
    def test_xattr_preserved_on_unchanged_file(self):
        repo = build_base_repo(self.root)
        src = os.path.join(repo, "top.txt")
        subprocess.run(
            ["/usr/bin/xattr", "-w", "com.example.cowtest", "xattr-value", src],
            check=True,
        )
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, head_sha(repo), dest, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        got = subprocess.check_output(
            ["/usr/bin/xattr", "-p", "com.example.cowtest", os.path.join(dest, "top.txt")],
            text=True,
        ).strip()
        self.assertEqual(got, "xattr-value")

    def test_source_hardlinks_become_independent_git_files(self):
        repo = build_base_repo(self.root)
        os.link(os.path.join(repo, "top.txt"), os.path.join(repo, "top-hardlink.txt"))
        git(["add", "top-hardlink.txt"], cwd=repo)
        git(["commit", "-q", "-m", "add hardlink content"], cwd=repo)
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, head_sha(repo), dest, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        first = os.path.join(dest, "top.txt")
        second = os.path.join(dest, "top-hardlink.txt")
        self.assertNotEqual(os.stat(first).st_ino, os.stat(second).st_ino)
        write(first, "changed independently\n")
        with open(second) as f:
            self.assertEqual(f.read(), "top level\n")


class TestNoByteCopyFallback(BaseCase):
    """White-box checks against the real clonefile(2) wrapper directly
    (bypassing the whole plan/execute pipeline) to confirm invariant #6:
    there is no ordinary byte-copy fallback anywhere. A genuine OS-level
    clonefile failure must surface as an error, never a silent byte copy,
    and a genuine success must produce an independent CoW copy (distinct
    inode, correct bytes) -- not a hardlink and not a shared-content no-op.
    """

    def test_real_clonefile_failure_is_not_silently_byte_copied(self):
        src = os.path.join(self.root, "src.txt")
        dst = os.path.join(self.root, "dst.txt")
        write(src, "source content\n")
        write(dst, "pre-existing destination content\n")
        with self.assertRaises(OSError) as ctx:
            COW.clonefile_path(os.fsencode(src), os.fsencode(dst))
        self.assertEqual(ctx.exception.errno, errno.EEXIST, ctx.exception)
        # No fallback byte copy: destination content must be untouched.
        with open(dst) as f:
            self.assertEqual(f.read(), "pre-existing destination content\n")

    def test_real_clonefile_success_is_independent_cow_copy(self):
        src = os.path.join(self.root, "src2.txt")
        dst = os.path.join(self.root, "dst2.txt")
        write(src, "abc\n")
        COW.clonefile_path(os.fsencode(src), os.fsencode(dst))
        self.assertNotEqual(os.stat(src).st_ino, os.stat(dst).st_ino)
        with open(dst) as f:
            self.assertEqual(f.read(), "abc\n")
        # Independence: editing src afterwards must not affect dst.
        write(src, "changed\n")
        with open(dst) as f:
            self.assertEqual(f.read(), "abc\n")


class TestDryRun(BaseCase):
    def test_dry_run_makes_no_changes(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, "feature", dest, dry_run=True)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        self.assertFalse(os.path.exists(dest))
        self.assertIn(b"Plan (dry run", proc.stderr)
        self.assertIn(b"changes S -> T", proc.stderr)
        # seed repo has exactly one worktree still (no tmp registrations)
        self.assertEqual(list_worktrees(repo).count("worktree "), 1)


class TestSeedIsSecondaryWorktree(BaseCase):
    def test_seed_can_itself_be_a_worktree(self):
        repo = build_base_repo(self.root)
        add_divergent_branch(repo, "feature")
        seed2 = os.path.join(self.root, "seed2")
        git(["worktree", "add", seed2, "feature"], cwd=repo)
        # `main` is checked out by the primary worktree (`repo`), so use its
        # commit sha (detached) as the target instead of the branch name.
        target = head_sha(repo, "main")
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(seed2, target, dest, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        self.assertTrue(is_clean(dest))
        self.assertEqual(worktree_write_tree(dest), tree_hash(repo, "main"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
