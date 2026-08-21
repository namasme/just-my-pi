#!/usr/bin/env python3
"""Defensive APFS copy-on-write Git worktree creator.

Thin, stable entrypoint. All logic lives in the sibling `cow_worktree_core`
package; see references/design.md for the algorithm and threat model, and
run with `--help` for CLI usage.
"""
from __future__ import annotations

import os
import sys

# Make the sibling `cow_worktree_core` package importable regardless of how
# this script is invoked: normal script execution already puts this
# directory on sys.path, but loading this file directly as a module (e.g.
# via importlib, as tests/test_cow_worktree.py does for white-box access)
# does not, so it's inserted explicitly here.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cow_worktree_core.cli import main, parse_args  # noqa: E402
from cow_worktree_core.clonefile import clonefile_path  # noqa: E402
from cow_worktree_core.orchestration import build_plan, execute_plan, print_plan  # noqa: E402

__all__ = ["main", "parse_args", "clonefile_path", "build_plan", "execute_plan", "print_plan"]

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
