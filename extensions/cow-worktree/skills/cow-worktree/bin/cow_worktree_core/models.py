"""Plain data carried through the validate -> plan -> execute pipeline."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class SeedInfo:
    path: str
    common_dir: str
    head_commit: str
    head_tree: str
    branch_ref: Optional[str]  # refs/heads/xxx or None if detached


@dataclass
class TargetInfo:
    commit: str
    tree: str
    branch_ref: Optional[str]


@dataclass
class Plan:
    seed: SeedInfo
    target: TargetInfo
    dest: str
    tmp_path: str = ""
    sidecar_path: str = ""
    tmp_dev: int = 0
    tmp_ino: int = 0
    private_gitdir: str = ""
    marker_token: str = field(default_factory=lambda: uuid.uuid4().hex)
    # Only reachable value outside this package's own test suite is False:
    # every COW_WORKTREE_TEST_* hook stays inert unless the hidden
    # --enable-test-hooks flag set this True (see cli.py, test_hooks.py).
    test_hooks_enabled: bool = False
