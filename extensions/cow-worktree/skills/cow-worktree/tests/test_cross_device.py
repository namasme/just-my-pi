#!/usr/bin/env python3
"""Automated cross-device rejection test using a throwaway APFS disk image.

`tests/test_cow_worktree.py::test_cross_device_destination_rejected_when_simulated`
documents that the *real* cross-device check is exercised here, against
`tests/_dmg/crossdev.dmg` -- a small, disposable APFS disk image checked
into the lab purely as test fixture data (it contains no monorepo content).

This mounts that image at a path *inside* the lab's `tests/_scratch`
directory (never under real monorepo checkouts),
then exercises `validate_same_device()` from both directions:

  * seed on the main volume, dest on the image
  * seed on the image, dest on the main volume

The image is always detached in cleanup, even if a test fails or is
interrupted. The whole class is skipped automatically if the image file,
`hdiutil`, or macOS device semantics are unavailable (e.g. on CI/Linux).
"""
import os
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from helpers import LAB_DIR, git, new_scratch_dir, rmtree_scratch, run_wrapper
from fixtures import build_base_repo

DMG_PATH = os.path.join(LAB_DIR, "tests", "_dmg", "crossdev.dmg")


def _hdiutil_available() -> bool:
    return shutil.which("hdiutil") is not None


def _head_sha(repo: str) -> str:
    return git(["rev-parse", "HEAD"], cwd=repo).stdout.decode().strip()


@unittest.skipUnless(sys.platform == "darwin", "hdiutil/APFS disk images are macOS-only")
@unittest.skipUnless(os.path.exists(DMG_PATH), "tests/_dmg/crossdev.dmg is missing")
@unittest.skipUnless(_hdiutil_available(), "hdiutil is unavailable")
class TestCrossDevice(unittest.TestCase):
    def setUp(self):
        self.root = new_scratch_dir(self._testMethodName)
        self.addCleanup(rmtree_scratch, self.root)
        self.mount_point = os.path.join(self.root, "dmg-mount")
        proc = subprocess.run(
            ["hdiutil", "attach", "-nobrowse", "-mountpoint", self.mount_point, DMG_PATH],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if proc.returncode != 0:
            self.skipTest(
                "could not attach crossdev.dmg: " + proc.stderr.decode(errors="replace")
            )
        self.addCleanup(self._detach)

        # Sanity: the mounted image really is a distinct device from the lab
        # volume. If not (e.g. some unusual APFS container setup), skip
        # rather than produce a false pass/fail.
        if os.stat(self.mount_point).st_dev == os.stat(LAB_DIR).st_dev:
            self.skipTest("mounted image landed on the same device id as the lab volume")

    def _detach(self):
        subprocess.run(
            ["hdiutil", "detach", "-force", self.mount_point],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_dest_on_other_device_rejected(self):
        repo = build_base_repo(self.root)
        dest = os.path.join(self.mount_point, "dest")
        proc = run_wrapper(repo, _head_sha(repo), dest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"different filesystem/device", proc.stderr)
        self.assertFalse(os.path.exists(dest))

    def test_seed_on_other_device_rejected(self):
        repo = build_base_repo(self.mount_point)
        # The disk image is a persistent file checked into the lab and
        # reused across mounts/runs (detach only unmounts, it does not wipe
        # content). Writing a repo onto it must not leak state into the
        # next mount, so always scrub it back off before detaching
        # (addCleanup runs LIFO, so this runs before setUp's _detach).
        self.addCleanup(shutil.rmtree, repo, True)
        dest = os.path.join(self.root, "dest")
        proc = run_wrapper(repo, _head_sha(repo), dest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"different filesystem/device", proc.stderr)
        self.assertFalse(os.path.exists(dest))


if __name__ == "__main__":
    unittest.main(verbosity=2)
