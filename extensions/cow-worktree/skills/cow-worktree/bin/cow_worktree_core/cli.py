"""Argument parsing and the `main()` entrypoint."""
from __future__ import annotations

import argparse
import sys

from .errors import CowError
from .log import LOG
from .orchestration import build_plan, execute_plan, print_plan

SHORT_DESCRIPTION = """\
Create a new Git worktree at DEST, checked out to TARGET, by CoW-cloning
SEED's tracked files with APFS clonefile(2) instead of a normal
`git worktree add` + full checkout.

SEED must be a clean, fully-tracked, non-sparse worktree; DEST must not
already exist in any form and must share SEED's filesystem device.

See references/design.md for the full algorithm and safety invariants."""


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="cow_worktree.py",
        description=SHORT_DESCRIPTION,
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
    # COW_WORKTREE_TEST_* environment variable is completely inert (see
    # test_hooks.py). Suppressed from --help: not supported end-user usage.
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
