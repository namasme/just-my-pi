---
name: cow-worktree
description: Create an APFS copy-on-write Git worktree from a clean seed worktree.
disable-model-invocation: true
compatibility: macOS with APFS, Git, and Python 3.9 or newer.
---

# CoW worktree

Create one worktree with the bundled defensive `clonefile(2)` wrapper. Treat the directory containing this file as `SKILL_DIR`. The executable is `SKILL_DIR/bin/cow_worktree.py`.

## Input

Accept these values from the command arguments or ask for any value that cannot be inferred:

- **Target:** a local branch, commit, or GitHub pull-request URL.
- **Destination:** an absolute path or a name beneath the seed's parent directory.
- **Seed:** defaults to `~/src/pristine-monorepo` for the monorepo work.
- **Branch:** defaults to the destination basename when the target is a pull request.

Resolve every path to an absolute path. The destination's parent must exist. The destination itself must not exist in any form.

## Procedure

1. **Inspect.** Confirm the seed is a Git worktree root. Record its `HEAD`, common Git directory, status, filesystem device, configured remote, and existing worktrees. Confirm the destination is absent.

2. **Resolve the target.**

   - For a branch or commit, resolve it inside the seed repository.
   - For a GitHub pull-request URL, apply the active work-system policy before accessing GitHub. Parse the PR number. Read `refs/pull/<number>/head` from the seed's remote. Fetch that ref into the chosen local branch:

     ```bash
     git -C "$SEED" fetch origin "pull/$PR/head:refs/heads/$BRANCH"
     ```

   - Fetching is a remote read. Do not push or perform any other remote write.
   - If the local branch already exists, verify that it points to the PR head and is not checked out. Do not force-update or delete a conflicting branch without explicit approval.
   - Record the immutable target commit. Use it for final verification.

3. **Protect the seed.** The wrapper requires zero tracked changes and zero untracked or ignored paths.

   - Stop on tracked or staged changes.
   - Never use `git clean`, `git reset --hard`, or deletion to make the seed clean.
   - List untracked and ignored paths. Ask before temporarily preserving unfamiliar content.
   - Known agent-generated content such as a top-level `.pi-subagents/` may be moved to a unique sibling backup for the run. Install an `EXIT`, `INT`, and `TERM` trap before moving it. Restore it on every handled exit. Refuse if the backup path already exists.
   - After restoration, verify every preserved path exists at its original location and the backup is gone. Report any backup left after an uncatchable interruption.

4. **Dry run.** Run the bundled wrapper with `--dry-run`. Save output to a unique log under `${TMPDIR:-/tmp}`. A failed dry run is a hard stop.

   ```bash
   python3 "$SKILL_DIR/bin/cow_worktree.py" \
     --seed "$SEED" \
     --target "$TARGET" \
     --dest "$DEST" \
     --dry-run
   ```

5. **Create.** Run the same command without `--dry-run`. Allow enough time for a blobless seed to materialize target blobs and clone every tracked inode. Save the full output to a second unique log.

6. **Verify.** All of these checks must pass:

   - `git -C "$DEST" rev-parse HEAD` equals the recorded target commit.
   - The checked-out branch is the chosen branch, or the worktree is intentionally detached.
   - `git -C "$DEST" status --porcelain` is empty.
   - The destination's common Git directory equals the seed's common Git directory.
   - The seed remains unchanged apart from restored pre-existing untracked or ignored content.
   - `git -C "$SEED" worktree list --porcelain` contains the destination exactly once.

7. **Report.** State the destination, branch or detached state, target commit, clean status, common Git directory, whether seed content was preserved and restored, and the two log paths.

## Safety contract

- Use the bundled wrapper rather than `cp`, `ditto`, or ordinary `git worktree add` for the checkout.
- Keep the destination on the seed's APFS device and under a private parent directory.
- Preserve all pre-existing paths. Never empty, replace, or remove an existing destination.
- Let the wrapper own temporary worktree cleanup. Do not manually remove its temporary path while it is running.
- Treat interruption by `SIGKILL` as potentially leaving an identifiable temporary worktree. Inspect `git worktree list` and the destination's parent before retrying.

Read [references/design.md](references/design.md) only when reviewing the algorithm, changing the wrapper, diagnosing a failure, or evaluating residual risks.
