# APFS CoW Git worktree wrapper

`bin/cow_worktree.py` creates a new Git worktree by cloning file content
from an existing clean worktree with macOS APFS `clonefile(2)`
copy-on-write, instead of doing a normal `git worktree add` + full checkout
(which writes every blob's bytes out of the object database, one file at a
time). The goal is to make creating a second, third, Nth checkout of a
huge monorepo (e.g. a large monorepo, ~370k files) much cheaper in time and disk
space when a clean, fully-populated worktree already exists to clone from.

This implementation began as an experimental lab artifact. It has since
successfully created linked worktrees from the real blobless
`pristine-monorepo` seed, including target-blob materialization and about
370,000 CoW-cloned tracked files. Keep the safety contract and limitations
below in force; successful pilots do not remove the residual race and
interruption risks.

This revision reflects **two hardening passes**. A first read-only
critic sent this back `BLOCK` pending six specific hardening areas
(cleanup ownership/symlink races, target-introduced gitlink rejection,
safe partial/promisor-clone support, content-verification/seed-mutation
races, ambient Git environment poisoning, and destination TOCTOU); all
six were implemented and tested, see "Hardening: six areas" below. A
*second*, independent critic then reviewed the result and returned
**GO, with four remaining conditions**: (1) test-only fault-injection
hooks were reachable via ambient environment variables alone in a
production run; (2) the reserved temp path's identity was not
re-verified immediately before *every* individual mutating step, only at
coarser checkpoints; (3) seed-mutation detection could in principle be
weakened by ambient Git config (fsmonitor/trustctime/checkStat); and (4)
a small check-to-move window at the very end could still race with a
concurrently created destination. All four are now resolved; see
"Second critic review: four conditions" below for exactly how, and for
the one residual, explicitly bounded and documented threat that is not
(and, without a kernel-level atomic primitive `git worktree move` doesn't
expose, cannot be) eliminated outright.

## Requirements

- macOS with an APFS volume that supports `clonefile(2)` (the seed
  worktree and the destination must be on the *same* such volume/device).
- `git` on `PATH`.
- Python 3.9+ (stdlib only, no third-party dependencies).

## Module layout

`bin/cow_worktree.py` is a stable, thin executable entrypoint: it adds its
own directory to `sys.path`, imports from the sibling `cow_worktree_core`
package, and re-exports the small set of names
(`build_plan`/`execute_plan`/`print_plan`/`clonefile_path`/`main`) that
`tests/test_cow_worktree.py` loads white-box for direct unit testing. All
behavior lives in `bin/cow_worktree_core/`:

| Module | Responsibility |
| --- | --- |
| `errors.py` | `CowError`, the one handled-failure exception type. |
| `log.py` | The shared stderr `Log`/`LOG` singleton. |
| `gitenv.py` | `git()`/`run()`/`git_verify()` subprocess helpers, environment sanitization, and the `-c` config overrides used by verification checks. |
| `models.py` | `SeedInfo`/`TargetInfo`/`Plan` dataclasses. |
| `clonefile.py` | The raw `clonefile(2)` ctypes binding. |
| `validation.py` | Seed/target/destination validation (steps 2-4 below). |
| `partial_clone.py` | Partial/promisor-clone detection and blob materialization (step 5). |
| `worktree_ops.py` | Reservation, registration, copy, transform, verification, move, and cleanup (steps 6-14). |
| `test_hooks.py` | Hidden fault-injection/adversarial hooks, gated by `Plan.test_hooks_enabled`. |
| `orchestration.py` | `build_plan()`, `print_plan()`, and `execute_plan()`, which sequences everything above. |
| `cli.py` | Argument parsing and `main()`. |

This split is an internal implementation detail for maintainability; it
does not change the CLI, behavior, or safety contract described below.

## Usage

```
python3 bin/cow_worktree.py --seed SEED_WORKTREE --target TARGET --dest DEST [--dry-run] [-v]
```

- `--seed`: path to the *top level* of an existing, clean, fully-tracked,
  non-sparse Git worktree to clone file content from. May itself be a
  full clone or a partial/promisor (blobless) clone (see "Partial/blobless
  clone support" below).
- `--target`: a branch name or commit to check out at `DEST`. If it is a
  local branch already checked out by another worktree (including the
  seed itself), the run is rejected -- Git only allows a given branch to be
  checked out in one worktree at a time. To target the exact commit a
  branch currently points at without that restriction, pass the raw commit
  SHA instead (a detached checkout).
- `--dest`: destination path. A relative value resolves beneath the seed's
  parent directory, independent of the caller's current directory. The
  resolved path **must not exist yet in any form** -- neither as a file,
  symlink, nor an existing (even empty) directory. Its parent directory
  must already exist (the wrapper never creates ancestor directories).
  It must resolve to the same filesystem/device as `--seed`.
  See "Hardening: six areas" #6 for why an empty directory is rejected
  too, not just tolerated.
- `--dry-run`: validate everything and print the plan (including a
  `git diff --stat` between the seed and target trees, and a report of how
  many target blob objects would need to be fetched for a partial-clone
  seed) without making any changes.
- `-v` / `--verbose`: print every `git` command run, for debugging.

Exit code `0` on success, `1` on a handled validation/operational failure
(with a message on stderr), `130` if interrupted (Ctrl-C).

## Algorithm

Let `S` = the seed worktree's current `HEAD` tree, `T` = the resolved
target tree.

1. **Resolve immutable IDs once.** Resolve the seed's `HEAD` commit/tree
   and the target's commit/tree at the start of the run and use those
   fixed IDs throughout -- never re-resolve a mutable ref mid-operation.
   `add_worktree` additionally re-checks the new worktree's `HEAD` right
   after registration against the previously-resolved target commit,
   closing the race where a branch moves between resolution and
   `git worktree add`.
2. **Validate the seed.** It must be the top level of a non-bare worktree,
   have a resolvable `HEAD`, not be a sparse checkout, and its tracked
   files must exactly match `HEAD` (both worktree and cached:
   `git diff --quiet --no-ext-diff HEAD --` and `--cached`) with zero
   untracked/ignored content (`git status --porcelain --ignored`). The
   seed's *entire* `HEAD` tree is recursively scanned (`git ls-tree -r`)
   for any `160000` (submodule/gitlink) entry at any depth, and rejected
   if one is found.
3. **Resolve and validate the target.** It must resolve to a commit
   inside the seed's repository. Its *entire* tree is independently,
   recursively scanned for gitlinks too -- a target that merely
   *introduces* a submodule relative to an entirely gitlink-free seed is
   rejected just as surely as a seed that already has one, and before any
   mutation. If it is a local branch, reject if that branch is already
   checked out in any existing worktree of that repository (including the
   seed).
4. **Resolve and validate the destination.** Anchor a relative destination
   beneath the seed's parent directory. The resolved path must not exist in
   any form (see "Hardening" #6), must have an existing parent, and must
   share a filesystem device with the seed (a same-device requirement
   `clonefile(2)` and
   `git worktree move` both share).
5. **Partial-clone preflight.** If the seed is a partial/promisor
   (blobless) clone, detect that and materialize (lazily fetch) every
   blob object the target tree needs that the seed's tree doesn't already
   have at the same path, then re-verify strict local availability with
   lazy fetching disabled (`GIT_NO_LAZY_FETCH=1`). This is the only point
   in the whole run where a network fetch happens, and it runs strictly
   *before* any reservation/registration below -- a network or missing-object
   failure here aborts fail-fast with nothing created. See "Partial/blobless
   clone support" below.
6. **Atomically reserve a wrapper-owned temporary directory *inode***
   (`os.mkdir`, not merely a sidecar file) immediately adjacent to `DEST`,
   and record its exact `(device, inode)`. This is the identity that
   `verify_reservation_intact()` re-checks via `lstat` immediately before
   *every single one* of the remaining steps below that touches the
   reserved path -- not just at a few coarse checkpoints -- before doing
   anything destructive or before any registration lookup; see
   "Second critic review" #2. An `O_EXCL` sidecar file recording a random
   per-run token is also written as a second, independent, filename-based
   ownership proof usable even in the narrow window before Git's own
   private-gitdir marker exists.
7. **Register a temporary linked worktree**: `git worktree add --no-checkout
   TMP <branch-or-commit>`, immediately preceded and followed by an
   identity re-check of the reserved inode. Git's own private-gitdir path
   is captured once, directly from this call, and used for every later
   ownership check -- never re-derived by `cd`-ing into `TMP` again. An
   identity re-check runs again immediately before the private marker
   file (token) is then written inside that private git dir (never
   inside the working tree, so it can never leak into `DEST`).
8. **Re-verify identity once more, then initialize the index to `S`**:
   `git read-tree S` (no `-u`, so this has no working-tree effect -- the
   index now describes `S`, but no files exist on disk yet).
9. **Re-verify the seed is still unmodified, re-verify identity, then
   CoW-clone every tracked path** (`git ls-files` from the seed) from the
   seed into the temporary worktree via a direct `clonefile(2)` call
   (through `ctypes`, not a `cp -c` subprocess per file -- at
   the monorepo's scale that subprocess overhead alone would dominate).
   Symlinks are cloned with `CLONE_NOFOLLOW` (clones the link itself, not
   its target). `.git` is never a valid tracked path and copying into
   anything under `.git` is refused defensively. **There is no byte-copy
   fallback**: if `clonefile` is unavailable or fails for any path, the
   run aborts.
10. **Re-verify identity, then refresh the index stat cache**:
    `git update-index --refresh`, mandatory and checked, and forced onto
    conservative Git config (`core.fsmonitor=false`,
    `core.trustctime=true`, `core.checkStat=default`; see "Second critic
    review" #3) -- `read-tree` leaves zeroed stat data, and this both
    fixes that up and fails the run if Git finds the freshly-copied files
    don't match what it expected.
11. **Re-verify identity, then transform `S` -> `T`**:
    `git read-tree -m -u S T`, a two-way merge that updates the *working
    tree* only for paths that actually differ between `S` and `T`. Files
    unchanged between `S` and `T` are left completely untouched, so they
    keep sharing physical storage with the seed via the CoW clone from
    step 9. Never `git reset --hard`, never `git clean`.
12. **Re-verify identity, then verify** the resulting worktree: `HEAD`
    equals the target commit, `git write-tree` equals the target tree,
    the checked-out branch (or lack thereof) matches, the common git dir
    matches the seed's, and `git status --porcelain --ignored` (also
    forced onto conservative config) is empty.
13. **Re-verify the seed is still unmodified, re-verify the reserved
    inode's identity, re-confirm `DEST` still does not exist in any
    form, then move into place**: `git worktree move TMP DEST` (never a
    raw filesystem rename, so Git's worktree registry stays consistent).
    Immediately after, git's own trusted private-gitdir record is
    re-read and checked to confirm it now points at `DEST` *exactly* --
    not a subdirectory of it -- which is how a foreign directory raced
    into existence in the narrow window between the pre-move check and
    the `git worktree move` call itself is detected explicitly rather
    than relying on an incidental later failure; see "Second critic
    review" #4. Then the full verification (worktree state +
    seed-unmodified) is re-run from `DEST` (paranoia -- the state must
    still hold after Git updates its administrative files).
14. **Finalize**: remove the private marker and the `O_EXCL` sidecar. Any
    failure at any point (including `KeyboardInterrupt`) triggers cleanup
    that removes *only* the path this exact run's reserved inode +
    sidecar + marker prove it owns; the seed and any pre-existing
    worktrees/paths (including a raced symlink or a concurrently-created
    `DEST`) are never touched.

## Hardening: six areas

Each area below was a specific `BLOCK` finding from a prior read-only
critic review. All six are implemented across `bin/cow_worktree_core/`
(see "Module layout" above) and each has at least one dedicated automated
test.

### 1. Cleanup ownership and symlink aliases

- `reserve_tmp_path()` atomically reserves a brand-new directory *inode*
  with `os.mkdir` (never just a sidecar file) before `git worktree add`
  ever runs, and records its exact `(st_dev, st_ino)`.
- `verify_reservation_intact()` does an `lstat`-based identity check
  (symlink? still a directory? same device+inode?) before every later
  security-sensitive step -- registration, marker capture, the final
  move -- and before `cleanup_owned()` does anything destructive.
- `cleanup_owned()` never calls `git worktree remove --force` unless
  ownership of the *exact* directory/gitdir is proven: either the private
  gitdir marker token matches, or the identity-checked path's own
  `gitdir` pointer file (read directly from git's trusted private admin
  dir, never by `cd`-ing into the untrusted path) resolves to the exact
  literal (non-symlink-following) path this run owns.
- After `git worktree remove --force`, the result is checked, and a
  stale-registration re-check (`registered_at()`) runs before any
  filesystem removal is attempted.
- Failure between `worktree add` and private-marker creation is covered
  by the `O_EXCL` sidecar alone (`test_failure_after_add_before_private_marker_cleanup`).
- Test: `tests/test_cow_worktree.py::TestSymlinkAliasAttack::test_temp_path_symlink_to_victim_worktree_is_never_touched`
  races the reserved path into a symlink pointing at a real, separately
  registered "victim" worktree (via a test-only injection hook, never
  reachable through normal code paths) and asserts the victim survives on
  disk, keeps its content, and stays registered, while the run fails
  loudly with `SECURITY` in its error output.

### 2. Reject target-only gitlinks

- `check_no_gitlinks_in_tree()` recursively scans a resolved tree with
  `git ls-tree -r` for any `160000` entry at any depth, and is called on
  *both* the seed's `HEAD` tree (`validate_seed`) and the target's tree
  (`resolve_target`) independently, before any mutation.
- Test: `tests/test_cow_worktree.py::TestSubmoduleGitlinkTargetRejected::test_target_introducing_submodule_rejected_before_registration`
  builds a seed with zero gitlinks whose *target* commit alone introduces
  a submodule, and asserts rejection happens during validation (exactly
  one worktree -- the primary -- exists afterward; no temp worktree was
  ever registered).
- (The seed-side case -- a gitlink already present in the seed itself --
  was already covered by the pre-hardening `TestFilesystemEdgeCases::test_submodule_gitlink_rejected`.)

### 3. Safely support the intended blobless seed

- `detect_partial_clone()` reports promisor-remote configuration
  (`remote.*.promisor`) or `.promisor` pack marker files.
- `target_blobs_to_materialize()` computes exactly which blob objects the
  target tree needs relative to the seed's tree (a raw, no-renames tree
  diff -- matching what `git read-tree -m -u` will actually need) *without*
  reading any blob content itself (tree-level diff only, so it works even
  when the diffed blobs aren't local yet).
- `materialize_target_objects()` runs this **strictly before**
  `reserve_tmp_path()`/`git worktree add`: it fetches (`git cat-file
  --batch-check`, which triggers Git's normal lazy-fetch machinery for a
  promisor remote) every needed blob, then re-verifies genuine local
  availability with `GIT_NO_LAZY_FETCH=1` -- so a lazy-fetch "success"
  that doesn't actually persist the object locally is still caught. A
  network or missing-object failure at this stage raises before anything
  is created.
- `describe_target_blob_status_readonly()` gives `--dry-run` a read-only
  (never-fetching) preview of the same information.
- Test: `tests/test_partial_clone.py` builds a **genuinely** blobless
  local seed (see its module docstring and `fixtures.build_promisor_seed`
  for why plain local `file://` clones don't actually produce one, and
  what's needed instead) and covers both:
  - the happy path (origin reachable): the wrapper succeeds and the
    previously-missing target blob is confirmed materialized afterward;
  - the failure path (origin renamed away, simulating a network/object
    failure): the run fails during the preflight step specifically, with
    zero worktree registrations, zero leftover temp paths, and zero
    destination created.
  - See "Partial/blobless clone support" below for how this fixture
    differs from a real monorepo/pristine-monorepo partial clone.

### 4. Content verification and seed mutation

- `verify_seed_unmodified()` is called at three points (before copying
  tracked files, before the final move, and after the final move) and
  checks, each time: `git diff --quiet --no-ext-diff HEAD --` (worktree
  vs `HEAD`), the cached equivalent (`--cached HEAD --`, index vs `HEAD`),
  and that `HEAD` itself still resolves to the exact commit resolved at
  the start of the run. `write-tree`/`status --porcelain --ignored`
  checks on the *new* worktree are retained unchanged in
  `verify_worktree()`.
- Test: `tests/test_cow_worktree.py::TestSeedMutationDuringRun` uses a
  test-only injection hook (`_maybe_mutate_seed_for_test`, inert unless a
  specific env var is set) that flips one byte of a tracked seed file
  while deliberately preserving its exact size and mtime -- the
  realistic version of a race that plain size/mtime-based staleness
  checks would miss -- at each of the two checkpoints, and asserts the
  run fails with "seed was mutated during this run" rather than producing
  an incorrect `DEST`. (A byte-identical-but-mtime-and-ctime-forged
  mutation is not caught by this alone; ctime cannot be forged by an
  unprivileged process without also controlling the system clock, so this
  is a documented, believed-acceptable residual -- see "Limitations".)

### 5. Sanitize ambient Git environment

- `sanitized_git_env()` strips a fixed set of repository/index/object
  redirection variables from every single `git` subprocess this wrapper
  runs (via the shared `git()` helper -- there is no other call site that
  invokes `git` directly): `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
  `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, plus `GIT_NAMESPACE`,
  `GIT_GRAFT_FILE`, `GIT_INDEX_VERSION`, `GIT_QUARANTINE_PATH`,
  `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`,
  `GIT_REPLACE_REF_BASE`, `GIT_SHALLOW_FILE`, `GIT_PREFIX`,
  `GIT_OPTIONAL_LOCKS`, and `GIT_ATTR_SOURCE_TREE`.
- **Policy**: variables that only affect *where* Git looks for the
  repository, index, or object store are stripped unconditionally, since
  every path this wrapper touches is always resolved explicitly (an
  absolute seed/tmp/dest path passed as `cwd`) and must never depend on
  ambient state. Authentication/network/config-behavior variables
  (`GIT_SSH*`, `GIT_ASKPASS`, `GIT_HTTP_*`, `GIT_CONFIG_*`, `GIT_TRACE*`,
  `GIT_NO_LAZY_FETCH`, proxy settings, etc.) are deliberately left alone,
  since the partial-clone preflight step (#3) legitimately needs a
  working, ambient network/auth configuration to fetch from a real
  promisor remote; `materialize_target_objects()`'s own strict
  re-verification additionally sets `GIT_NO_LAZY_FETCH=1` as an explicit,
  intentional *override* on top of the sanitized base environment for
  that one check.
- Test: `tests/test_cow_worktree.py::TestAmbientEnvironmentPoisoning`
  poisons `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR`/
  `GIT_OBJECT_DIRECTORY`/`GIT_ALTERNATE_OBJECT_DIRECTORIES` to point at a
  real decoy repository (and, separately, at nonexistent paths) before
  invoking the wrapper, and asserts: the run still succeeds against the
  real seed/dest paths given on the command line, the poisoned
  `GIT_INDEX_FILE` path is never created, and the decoy repo is left
  completely untouched (still clean, still exactly one worktree).

### 6. Destination TOCTOU

- `validate_dest()`'s policy is now: `DEST` must not exist **in any
  form**, including as an empty directory (`os.path.lexists`, not merely
  "exists and non-empty") -- see its docstring/comment for why tolerating
  an empty directory would itself require this wrapper to remove it
  right before the move, i.e. reintroduce the exact TOCTOU this policy
  eliminates. `move_worktree()` re-checks this again, immediately before
  invoking `git worktree move`, and refuses (without removing anything)
  if `DEST` has come into existence in the interim.
- Test:
  `tests/test_cow_worktree.py::TestRejections::test_existing_empty_destination_rejected`
  (updated from a prior "tolerate empty directory" expectation to assert
  rejection, and that the pre-existing empty directory survives
  untouched) and
  `tests/test_cow_worktree.py::TestDestinationTOCTOU::test_concurrently_created_destination_fails_safely_without_removal`
  (a test-only injection hook creates `DEST` concurrently, between
  validation and the final move; asserts the run fails safely, the
  foreign directory survives untouched and empty, and no wrapper temp
  path or extra worktree registration is left behind).

## Second critic review: four conditions

A second, independent read-only critic reviewed the six-area hardening
pass above and returned **GO, with four remaining conditions**, all now
resolved in `bin/cow_worktree_core/`, each with dedicated tests.

### 1. Test-only hooks must require an explicit flag, not just an env var

- **Problem**: every `COW_WORKTREE_TEST_*` fault-injection/adversarial
  hook (symlink-alias attacks, seed mutation, forced failures at specific
  stages, destination races) was gated only on its own environment
  variable being set -- so an ambient environment variable, inherited by
  accident (e.g. leaked from a parent shell or CI job), could silently
  change a *production* run's behavior.
- **Fix**: `Plan.test_hooks_enabled` (default `False`) gates every single
  hook in `cow_worktree_core/test_hooks.py` -- each hook function's very
  first line is
  `if not enabled: return` (or the plan-level equivalent), so no
  `COW_WORKTREE_TEST_*` variable is even *read* unless this is `True`.
  It is only ever set `True` via a hidden, non-default, `argparse.SUPPRESS`-hidden
  CLI flag (`main()`/`parse_args()`) that is deliberately not spelled out
  in the script's `--help`-visible module docstring or in `--help`
  output itself -- see `tests/test_cow_worktree.py`'s
  `TestTestHooksDisabledByDefault::test_enable_test_hooks_flag_is_hidden_from_help`.
  This is test infrastructure only, not a supported end-user feature; see
  [the hardening report](hardening-report.md) for its review history and
  `tests/helpers.py::run_wrapper()`'s `enable_test_hooks`
  parameter (only ever `True` in tests that actually inject a fault).
- Test: `tests/test_cow_worktree.py::TestTestHooksDisabledByDefault`.
  `test_ambient_hook_env_vars_alone_are_completely_inert` sets **every**
  hook's environment variable simultaneously (symlink-alias attack
  targeting a real established victim worktree, forced mid-run failure,
  seed mutation, and both destination-race variables) *without* the
  hidden flag, and asserts the run succeeds completely normally: the
  correct `DEST` is produced, the seed and the victim worktree are both
  completely unaffected and still registered, and no hook-induced
  failure or side effect occurs anywhere.

### 2. Re-verify reserved-path identity before *every* mutating step, not just at checkpoints

- **Problem**: the first hardening pass's `verify_reservation_intact()`
  calls were concentrated at a few coarse checkpoints (registration,
  marker capture, the final move), leaving a window where a race that
  won *between* two specific later steps (e.g. between index
  initialization and the CoW copy) would not be caught until the next
  checkpoint, if at all.
- **Fix**: `execute_plan()` now calls `verify_reservation_intact()`
  immediately before *every* individual step that touches the reserved
  path: before and after `add_worktree()`, before private-gitdir
  capture, before the private marker write, before index
  initialization, before the CoW copy, before the index refresh, before
  the `read-tree` transform, before worktree verification, and before the
  final move -- see the Algorithm section's steps 6-13 above for exactly
  where each one sits in the pipeline. `cleanup_owned()` independently
  re-does its own `lstat` identity check immediately before every
  destructive command it might issue (both the `git worktree remove
  --force` call and the final `shutil.rmtree`), never relying on an
  identity check done earlier in the run.
- A second, *later* adversarial hook
  (`_maybe_inject_symlink_attack_post_marker` /
  `COW_WORKTREE_TEST_SYMLINK_ATTACK_POST_MARKER_TARGET`) simulates a race
  that only wins *after* `git worktree add` and the private marker
  already exist (i.e. after the original `TestSymlinkAliasAttack`
  window has already closed), replacing the reserved directory with a
  symlink to an established victim worktree at that later point instead.
- Test:
  `tests/test_cow_worktree.py::TestSymlinkAliasAttackPostMarker::test_temp_path_symlink_to_victim_after_marker_is_never_touched`
  asserts the run fails loudly (`SECURITY`, naming the exact
  "index initialization" step at which it was caught), and that the
  victim's `HEAD`, index/files, and worktree registration are all
  completely unchanged afterward -- proving the per-step re-checks catch
  a post-registration race, not just a pre-registration one.

### 3. Seed-mutation verification must not depend on ambient Git config

- **Problem**: a plain `git diff --quiet` can be made to falsely report
  "clean" by ambient configuration the wrapper does not control: a
  malicious/stale `core.fsmonitor` hook that always claims nothing
  changed, `core.trustctime=false` (common, if misguided, NFS advice),
  or `core.checkStat=minimal` (checks fewer stat fields) all weaken the
  check without touching the wrapper's own code or command line.
- **Fix**: `git_verify()` wraps every security-relevant
  cleanliness/mutation/identity check (`verify_seed_unmodified()`,
  `validate_seed()`'s dirty/untracked checks, `refresh_index()`,
  `verify_worktree()`'s clean-status check) with `-c` command-line config
  overrides -- `core.fsmonitor=false`, `core.trustctime=true`,
  `core.checkStat=default` -- applied via `_VERIFY_GIT_CONFIG_ARGS`. `-c`
  on the command line has the highest precedence of any Git config
  source, higher than repository/global/system config files *and*
  higher than `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`
  environment-variable config (which `sanitized_git_env()` deliberately
  does *not* strip, since that mechanism is also legitimately used for
  partial-clone/auth configuration) -- so no combination of ambient
  config, files or environment, can weaken these specific three settings
  for these specific checks.
- This does **not** replace `git diff --quiet`/`git update-index
  --refresh` with an independent full-content re-hash of every tracked
  path read a second time in userspace -- that would mean paying the
  cost of a second full read pass over every tracked file's bytes, at
  the monorepo scale, purely to duplicate what Git's own stat-then-hash-on-
  ambiguity logic already does once these three settings are forced
  conservative. Forcing them is the strongest correct Git-native content
  check achievable here without that additional full-content-read cost;
  see `cow_worktree_core/gitenv.py`'s `_VERIFY_GIT_CONFIG_ARGS` comment
  for the full per-setting rationale.
- Test:
  `tests/test_cow_worktree.py::TestSeedMutationDuringRun` now has, in
  addition to the original same-size/same-mtime mutation-injection tests
  (`test_seed_mutated_before_copy_is_detected`,
  `test_seed_mutated_before_move_is_detected`), two hostile-config
  variants
  (`test_seed_mutated_before_copy_is_detected_despite_poisoned_verification_config`,
  `test_seed_mutated_before_move_is_detected_despite_poisoned_verification_config`)
  that additionally poison `core.fsmonitor` (to `/usr/bin/true`, an
  always-"clean" hook), `core.trustctime` (to `false`), and
  `core.checkStat` (to `minimal`) via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/
  `GIT_CONFIG_VALUE_*` before running the same same-size/same-mtime
  mutation, and assert the mutation is still detected and the run still
  fails safely despite that poisoning.

### 4. The final destination check-to-move window

- **Problem**: `move_worktree()` checks `DEST` does not exist immediately
  before calling `git worktree move`, but a pathname-based filesystem
  check followed by a pathname-based subprocess call cannot be made
  atomic with each other from Python without a kernel primitive `git
  worktree move` itself does not expose -- so a vanishingly small window
  remains in which a concurrent process could still create `DEST`
  (empty or with real content) between the check and the actual move.
- **What was verified, empirically, about what happens if that window is
  hit**: `git worktree move` treats an *existing* destination directory
  as a place to move **into**, not as an error -- confirmed by hand
  against the real `git worktree move` (git 2.54) before writing any
  test or fix: moving a temporary worktree onto a pre-existing directory
  containing a foreign file exits `0` and leaves the temporary worktree
  nested one level deeper (`DEST/<tmp-name>/...`), with the pre-existing
  foreign file completely untouched alongside it.
- **Fix (detect-and-fail-safe, not eliminate)**: `move_worktree()` now
  explicitly re-reads git's own trusted private-gitdir record
  immediately after the move and confirms it points at `DEST`
  *exactly*, not a subdirectory of it. If the race was hit, this fails
  loudly and explicitly ("destination was raced into existence during
  the final move...") instead of silently succeeding or failing later
  for an unrelated, confusing reason. `execute_plan()`'s failure-cleanup
  path then uses that same trusted record (not the original `tmp_path`)
  to identify and remove *only* the nested worktree this run created,
  leaving the foreign directory and its content completely untouched.
- **This race is bounded and non-destructive, not eliminated.** It can
  only ever make the run fail loudly with the foreign content preserved
  -- it cannot delete, empty, or overwrite anything that was already at
  `DEST`, and it cannot cause a wrong `DEST` to be reported as
  successful (the private-gitdir re-check catches that explicitly). It
  is not eliminated outright because doing so would require `DEST`'s
  parent directory to itself be a private, not-concurrently-writable
  location for the duration of a run -- **a real pilot must use such a
  private parent directory** to close this window completely; this
  wrapper alone cannot guarantee that a shared/world-writable parent
  directory is race-free.
- Test:
  `tests/test_cow_worktree.py::TestDestinationTOCTOU::test_check_to_move_race_preserves_foreign_content`
  injects real foreign file content into `DEST` strictly inside
  `move_worktree()`'s own check-to-move window (via a dedicated test-only
  hook placed exactly there, `_maybe_create_dest_with_content_race_for_test`
  / `COW_WORKTREE_TEST_CREATE_DEST_WITH_CONTENT_DURING_MOVE` -- distinct
  from the coarser, pre-existing
  `test_concurrently_created_destination_fails_safely_without_removal`,
  which creates `DEST` *before* `move_worktree()` is even called and is
  therefore caught by its own leading `os.path.lexists` check without
  ever invoking `git` at all) and asserts: the run fails with the new,
  explicit error message; the foreign file's exact byte content survives
  unchanged; the nested worktree this run created is fully cleaned up
  (nothing else left inside `DEST`); and exactly the original primary
  worktree remains registered afterward.

## Environment sanitization policy (summary)

Every `git` subprocess this wrapper runs has the variables listed in
"Hardening" #5 stripped from its environment first (`sanitized_git_env()`
in `cow_worktree_core/gitenv.py`), specifically so that no combination of ambient
`GIT_*` environment variables can redirect any command this wrapper
issues at a different repository, index, or object store than the exact,
explicitly-resolved path it was given as `cwd`. Authentication, network,
and general Git-config-behavior variables are intentionally preserved,
because the partial-clone preflight step legitimately needs them to
authenticate/fetch from a real promisor remote.

## Partial/blobless clone support

The seed may be a partial/promisor (blobless) clone. Before any worktree
registration or mutation, the wrapper materializes every blob the target
tree needs beyond what the seed's tree already has, and strictly
re-verifies local availability with lazy fetching disabled. See
"Hardening" #3 above for the mechanism and `tests/test_partial_clone.py`
for the integration test.

**How the automated test fixture differs from a real
monorepo/pristine-monorepo partial clone:**

- It is a tiny, synthetic, single-branch-diff repo rather than a ~370k-file
  monorepo. Real pilots have materialized more than 12,000 target blobs and
  cloned about 370,000 tracked files successfully, but those runs are not a
  repeatable performance or failure-mode test suite.
- The "remote" is a `file://` origin on the same local machine, forced
  through Git's smart-protocol (upload-pack) path with `--no-local` and
  `uploadpack.allowfilter=true` purely so that the filter is actually
  honored instead of silently ignored by the local-clone fast path (see
  `fixtures.build_promisor_seed`'s docstring). There is no real network
  latency, authentication, proxying, or remote-side rate limiting in this
  test -- all of which a real partial-clone fetch against an internal
  Git host would have to contend with.
- The failure-path test simulates "network unreachable" by renaming the
  origin directory away; it does not exercise timeouts, partial
  reads, auth failures, or a remote that serves some but not all
  requested objects.
- Only a single promisor remote is considered; alternates or multiple
  object directories beyond the seed's own common dir are not walked
  (documented in `detect_partial_clone()`'s docstring too).

## Safety contract

- The seed worktree is **never modified**. It is only read from (`git
  ls-files`, `clonefile` as the *source*, various read-only `git`
  inspection commands), and is explicitly re-verified unmodified at
  multiple points during the run (see "Hardening" #4).
- Existing worktrees other than the one this run creates are **never**
  removed, moved, or reset -- including one aliased via a raced symlink
  (see "Hardening" #1).
- No `git reset --hard` and no `git clean` are used anywhere. All working
  tree state changes are explicit (`git read-tree ... -u`), confined to
  the wrapper's own temporary worktree.
- Failure cleanup only ever removes a path this run can positively prove
  it owns (reserved directory inode identity + `O_EXCL` sidecar token,
  later corroborated by a private-gitdir marker once registration
  completes far enough for one to exist) -- never based on trusting the
  path's name or contents alone.
- A mutable branch moving during the operation, or the seed's tracked
  content changing during the operation, is detected and treated as a
  hard failure, not silently baked into an inconsistent `DEST`.
- `DEST` must not exist in any form beforehand, and is re-checked
  immediately before the final move; a concurrently-created `DEST` is
  left completely untouched.
- Every `git` subprocess runs with dangerous repository-redirection
  environment variables stripped (see "Hardening" #5).

## Tests

```
python3 -m py_compile bin/cow_worktree.py bin/cow_worktree_core/*.py tests/*.py bench/benchmark.py
python3 tests/test_cow_worktree.py -v          # 42 tests, ~1.5 min
python3 tests/test_cross_device.py -v          # 2 tests, needs hdiutil/macOS, ~6s
python3 tests/test_partial_clone.py -v         # 2 tests, needs git --filter support, ~10s
python3 -m unittest discover -s tests -p 'test_*.py' -v   # everything, 46 tests, ~1.5-2 min
```

All tests run under `tests/_scratch/` inside this lab directory only.
`tests/helpers.py` enforces (via `_guard()`) that nothing under test ever
touches a path containing `example-org/monorepo` or
`example-org/pristine-monorepo`, and that all touched paths stay inside this
lab directory.

`tests/test_cross_device.py` mounts the disposable fixture image
`tests/_dmg/crossdev.dmg` (a tiny throwaway APFS volume, no the monorepo
content) at a path inside `tests/_scratch`, to exercise the real
cross-device rejection in both directions, and always detaches it
(and scrubs any data it wrote onto the image) in cleanup. It skips itself
automatically on non-macOS hosts or if `hdiutil`/the image are unavailable.

`tests/test_partial_clone.py` builds a genuinely blobless local partial
clone (see "Partial/blobless clone support" above) and exercises the
preflight-materialization happy path and network-failure-before-any-mutation
path. It skips itself if the local git/platform doesn't actually produce
a partial clone this way.

## Benchmark

```
python3 bench/benchmark.py                                   # defaults: 10,000 files x 8,192 bytes
COW_BENCH_FILES=50000 COW_BENCH_FILE_SIZE=1024 python3 bench/benchmark.py
```

Creates a synthetic seed repo under `tests/_scratch/benchmark`, times an
ordinary `git worktree add --detach` versus the wrapper creating a second
worktree at the same commit, and removes the scratch data again when done
(set `COW_BENCH_KEEP=1` to keep it for inspection). See the
[hardening report](hardening-report.md) for recorded results and their
caveats -- in particular, `du` reports *logical* size and double-counts
extents shared between the two trees, so it is not evidence of storage
savings, and APFS free-space deltas on a live volume are noisy enough
(delayed reclamation) to sometimes go negative for the CoW run. Treat the
timing numbers as illustrative, single-sample measurements, not a rigorous
benchmark. The final hardening pass did not rerun the benchmark because it
did not change the hot copy path.

## Limitations

- **Piloted, not production-hardened.** The wrapper has created real
  the monorepo worktrees from `pristine-monorepo`, but the automated suite
  still uses small synthetic fixtures. Keep dry-run and final verification
  mandatory for every real invocation.
- **macOS/APFS + `clonefile(2)` only.** No Linux/Windows support, no
  fallback to a different filesystem or a byte copy. If the destination
  isn't a clonefile-capable APFS volume on the same device as the seed,
  the run refuses rather than silently doing something slower/different.
- **Submodules/gitlinks are rejected outright**, not recursively handled,
  whether they originate from the seed or are introduced by the target.
- **Git does not model hardlinks.** If the seed has multiple tracked
  paths that happen to be hardlinked together on disk, the cloned paths in
  `DEST` become independent files (each individually CoW-cloned from the
  seed's copy), not hardlinked to each other or to the seed.
- **CoW saves data blocks, not inode/directory metadata.** For a
  the monorepo-scale checkout (~370k files), creating that many directory
  entries and inodes still has a substantial, unavoidable metadata cost
  and wall-clock time even when the underlying data extents are shared.
- **APFS free-space measurements on a live volume are noisy** (delayed
  reclamation, background processes); `du` reports logical size and
  double-counts extents shared between the seed and the clone. Neither is
  reliable storage-savings evidence on its own.
- **Partial-clone support has limited real-world evidence.** Real
  `pristine-monorepo` pilots successfully materialized thousands of blobs,
  while the repeatable integration test remains a small local fixture. It
  does not exercise remote timeouts, authentication failures, partial reads,
  or rate limits. See "Partial/blobless clone support" above.
- **Create a parallel worktree and leave the seed untouched.** This is the
  validated pilot shape and the behavior covered by
  `TestSeedIsSecondaryWorktree` and `TestIndependenceAndIntegrity`.
- **Races are detected and failed safely at every step, not eliminated,
  and DEST's parent directory must be private for a real pilot.** Every
  mutating step's reserved-path identity is re-checked immediately
  before it runs (see "Second critic review" #2), and seed content
  mutation / destination recreation are hard failures with cleanup, not
  silently ignored -- but a race that wins in one of these specific,
  narrow windows is *detected and failed safely*, not prevented from
  occurring in the first place. Two specific, deliberately not-eliminated
  cases are documented in detail above: (a) a mutation that preserves a
  tracked seed file's exact size, mtime, *and* ctime simultaneously would
  not be caught by `verify_seed_unmodified()` (forging ctime requires
  controlling the system clock, out of scope for an unprivileged local
  race; see "Second critic review" #3); and (b) the final
  check-to-move window for `DEST` (see "Second critic review" #4) is
  bounded and non-destructive -- it can only cause a loud, explicit
  failure with foreign content preserved, never data loss or a
  falsely-reported success -- but is not atomically eliminated, because
  doing so would require a kernel primitive `git worktree move` does not
  expose. **A real pilot must place `DEST` under a private (not
  concurrently writable by any other process/user) parent directory** to
  close that window completely; this wrapper alone cannot guarantee a
  shared/world-writable parent is race-free, and does not attempt to.
- **A `SIGKILL` (or any signal Python cannot catch) mid-run will skip the
  `except`/cleanup path.** The `O_EXCL` sidecar and private marker still
  allow a *future* run (or a human) to identify and remove the orphaned
  temporary worktree, but this wrapper does not do that automatically on
  its own next invocation.
- **Test-only fault-injection hooks exist in the shipped module** (gated
  behind a hidden, non-default CLI flag -- see "Second critic review"
  #1). They are inert in every normal invocation (proven by
  `TestTestHooksDisabledByDefault`), but their mere presence in the
  source is itself a residual: a reviewer of the code, not just its
  runtime behavior, must confirm the gating is intact rather than
  assuming it from this document alone.
