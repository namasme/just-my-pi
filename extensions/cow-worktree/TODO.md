# TODO

Open findings from the adversarial review of commit `11743a1`.

## Correctness and safety

### Make dry runs network-free

`cow_worktree_core.orchestration.print_plan()` calls `git diff --stat` after the read-only partial-clone check. On a blobless seed, that command may lazily fetch changed blobs even though the dry-run output and design document promise that a dry run never fetches.

- Run the diffstat with `GIT_NO_LAZY_FETCH=1` and `check=False`.
- If the blobs are unavailable, report that the diffstat is unavailable without fetching.
- Add a partial-clone test that records a missing blob, runs `--dry-run`, and proves the blob remains missing locally.

This behavior predates the module split.

### Roll back incomplete temporary-path reservations

`cow_worktree_core.worktree_ops.reserve_tmp_path()` creates the temporary directory before opening and writing its ownership sidecar. Failures other than the handled sidecar collision can leave the directory, and sometimes the sidecar, behind. The caller cannot clean these paths because reservation happens before its cleanup handler has the returned ownership data.

- Wrap every operation after `os.mkdir()` in local failure cleanup.
- On any `BaseException`, remove only the directory and sidecar created by that attempt, then re-raise.
- Add tests for sidecar open, write, and interruption failures. Assert that no `.cow-wt-tmp.*` or `.cow-owner` path remains.

This behavior predates the module split.

## Refactor follow-ups

### Centralize all test hooks

`COW_WORKTREE_TEST_FAIL_AFTER_COPY` is still read directly in `cow_worktree_core.worktree_ops`, while the new module boundary says `cow_worktree_core.test_hooks` owns fault injection.

- Move the gated lookup into `test_hooks.py`.
- Keep the default-off behavior unchanged.
- Add a check that production modules contain no `COW_WORKTREE_TEST_*` lookup outside `test_hooks.py` and CLI gating documentation.

### Automate symlink invocation coverage

The documented directory-symlink installation and a direct file-level symlink both work in manual checks, but the suite invokes the wrapper only through its real source path.

- Add an end-to-end invocation through a symlinked skill directory.
- Add a `--help` invocation through a file-level symlink to `cow_worktree.py`.
- Pin the thin entrypoint's intended re-export surface in a small import test.

### Remove stale code and documentation

- Remove the unreachable direct-execution block from `cow_worktree_core/cli.py`, or explicitly support and document `python -m cow_worktree_core.cli`.
- Update test counts in `references/design.md` to 43 main tests and 47 total tests.
- Change old test comments that point to the removed monolithic `cow_worktree.py` “Test-only injection hooks” section so they point to `cow_worktree_core/test_hooks.py`.
- Correct `test_cross_device.py` documentation: the APFS disk image is not shipped, so those two tests skip on a fresh checkout.

## Optional hardening

### Narrow the raw subprocess helper

`cow_worktree_core.gitenv.run()` permits `env=None`, which inherits the ambient environment without Git sanitization. Its current caller supplies an intentional environment, but the shared helper is an easy future footgun.

- Make the environment a required keyword argument, or make the helper private to its current use.

### Encode reservation checks structurally

`execute_plan()` relies on explicit `verify_reservation_intact()` calls before each mutating operation. The current ordering is correct, but a future operation could omit its check.

- Explore a guard object or narrow wrapper around mutating worktree operations that performs the identity check by construction.
- Preserve the current explicit context strings and cleanup ownership model.
