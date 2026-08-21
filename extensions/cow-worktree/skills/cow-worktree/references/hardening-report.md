# REPORT: APFS CoW Git worktree wrapper -- second-critic-conditions pass

## Handoff state at the start of this pass

This pass's task was to resolve four remaining conditional blockers from
a **second** independent read-only critic review (the first critic's six
`BLOCK` areas had already been resolved in an earlier pass; see
"Hardening: six areas" in `README.md`). Two prior worker attempts at this
exact task ("cow-final-hardener", "cow-final-recovery") had run before
this pass and reportedly failed at the harness/terminal level partway
through, per the delegating task's own description ("prior worker
surfaces failed, so inspect current state first").

Inspecting the lab at the start of this pass (before making any change)
showed the prior attempt(s) had, in fact, made substantial real progress
directly in `bin/cow_worktree.py` and `tests/test_cow_worktree.py`:

- **Condition 1** (hidden test-flag gating): fully implemented.
  `Plan.test_hooks_enabled` (default `False`), a hidden
  `--enable-test-hooks` `argparse.SUPPRESS`-ed CLI flag, and every
  `COW_WORKTREE_TEST_*` hook function gated on it (`if not enabled:
  return`) were all present and correct.
- **Condition 2** (per-step identity re-verification): fully implemented.
  `execute_plan()` already called `verify_reservation_intact()`
  immediately before every individual mutating step (registration,
  private-gitdir capture, marker write, index init, CoW copy, index
  refresh, tree transform, verification, move). A post-marker adversarial
  symlink-alias hook and its test
  (`TestSymlinkAliasAttackPostMarker::test_temp_path_symlink_to_victim_after_marker_is_never_touched`)
  were also already present and correct.
- **Condition 3** (config-independent seed verification): fully
  implemented. `git_verify()` forcing `-c core.fsmonitor=false -c
  core.trustctime=true -c core.checkStat=default` on every
  security-relevant check, and hostile-config-poisoned variants of the
  same-size/same-mtime mutation tests
  (`test_seed_mutated_before_copy_is_detected_despite_poisoned_verification_config`,
  `...before_move_...`), were already present and correct.
- **Condition 4** (destination check-to-move race): **partially**
  implemented. `move_worktree()` already re-checked `DEST` did not exist
  immediately before calling `git worktree move`, and a test
  (`TestDestinationTOCTOU::test_concurrently_created_destination_fails_safely_without_removal`)
  already covered *that* specific check -- but that check/test only
  covers a race that wins **before `move_worktree()` is even called**
  (`_maybe_create_dest_race_for_test`, invoked from `execute_plan()`
  ahead of `move_worktree()`), which `move_worktree()`'s own leading
  `os.path.lexists()` re-check catches without ever invoking `git`. The
  narrower, genuine check-to-move TOCTOU **inside** `move_worktree()`
  itself -- between that `os.path.lexists()` call and the `git worktree
  move` subprocess call -- was neither exercised by a test nor even
  explicitly detected by the code if hit (see "What this pass found and
  fixed" below).
- **The referenced but missing test**: both the module's own comments
  (`bin/cow_worktree.py`, "Test-only injection hooks" section) and
  `tests/helpers.py`'s docstring already referred to a
  `TestTestHooksDisabledByDefault` test class as covering condition 1's
  "ambient env alone is inert" requirement -- but that class did not
  actually exist anywhere in `tests/test_cow_worktree.py`. The
  implementation was correct; the falsifying test the task explicitly
  required ("tests proving env alone is inert") was missing.

`README.md` (at the time, last touched well before this pass) and
`REPORT.md` (describing only the *first* critic's six areas) had **not**
been updated to reflect any of conditions 1-4 at all -- neither the
partially-done condition 4 work nor the fully-done conditions 1-3.

## What this pass found and fixed

### 1. Confirmed empirically: `git worktree move` onto an existing directory nests, does not error

Before writing any test or fix for condition 4, this pass manually
verified (in a disposable `/tmp` scratch directory, never touching the
lab's own `tests/_scratch` or real monorepo checkouts) exactly what
`git worktree move TMP DEST` (git 2.54.0) does when `DEST` already exists
as a non-empty directory:

```
$ git worktree move tmpwt "$(pwd)/dest"     # dest/ already contains foreign.txt
$ echo $?
0
$ find dest -maxdepth 3
dest
dest/tmpwt
dest/tmpwt/.git
dest/foreign.txt
```

It **exits 0** (success) and nests the moved worktree one level deeper
(`DEST/<tmp-basename>/...`), leaving the pre-existing foreign content
untouched alongside it. This is a real, verified, non-hypothetical
consequence of hitting the check-to-move race, and it means a naive
`move_worktree()` implementation that only checks `os.path.islink(dest)
or not os.path.isdir(dest)` after the call (which the code already did)
would **not** notice this happened -- `dest` genuinely is a plain
directory afterward, just not the one the wrapper actually intended to
produce. (In the full pipeline, `verify_worktree(plan.dest, ...)`
immediately afterward would still catch this incidentally, because
`plan.dest` itself is not a git worktree in the nested case and `git
rev-parse HEAD` run with that `cwd` fails -- but relying on that
incidental failure, rather than checking explicitly, was not an
acceptable fix for a task explicitly asking to "document the bounded
race/private-parent threat model" and to prove foreign content survives.)

### 2. Fixed: `move_worktree()` now explicitly detects the nested-move outcome

Changed `move_worktree()` (now taking `private_gitdir` and
`test_hooks_enabled` parameters) to, immediately after `git worktree
move` returns successfully, re-read git's own trusted private-gitdir
record (`read_private_gitdir_workdir()` -- the same mechanism
`cleanup_owned()` already used, never a `cd`-into-the-untrusted-path
check) and confirm it now points at `DEST` **exactly**, not a
subdirectory of it. If the race was hit, this raises a new, explicit,
specific `CowError` ("destination was raced into existence during the
final move...") instead of relying on some later, incidental command
failure for an unrelated-looking reason. `execute_plan()`'s existing
failure-cleanup path (which already read this same trusted record to
find the *actual* current path before calling `cleanup_owned()`) required
no further change -- it already correctly identifies and removes only
the nested worktree this run created in this scenario, never the foreign
directory itself.

Also added a code comment directly above the race window documenting
this as a **bounded, detect-and-fail-safe, not atomically-eliminated**
race, and why: closing it fully would require `DEST`'s parent directory
to be private (not concurrently writable) for the run's duration, a
guarantee this wrapper cannot make about an arbitrary caller-supplied
path -- this is now also documented in `README.md`'s "Second critic
review" #4 and "Limitations" sections as a required pilot guardrail.

### 3. Added the two missing tests

- **`TestDestinationTOCTOU::test_check_to_move_race_preserves_foreign_content`**
  (condition 4): a new, narrower test-only hook
  (`_maybe_create_dest_with_content_race_for_test` /
  `COW_WORKTREE_TEST_CREATE_DEST_WITH_CONTENT_DURING_MOVE`) is invoked
  from *inside* `move_worktree()`, strictly between its
  `os.path.lexists()` check and the `git worktree move` subprocess call
  -- i.e. exactly inside the real race window, not before
  `move_worktree()` is even called -- and creates `DEST` with a real
  foreign content file (not just an empty directory, per the task's
  explicit "final destination creation ... preserves foreign content"
  requirement). The test asserts: the run fails with the new explicit
  error message; the foreign file's exact byte content survives
  unchanged; nothing else is left inside `DEST` (the nested worktree this
  run created was fully cleaned up); and exactly the original primary
  worktree remains registered afterward.
- **`TestTestHooksDisabledByDefault`** (condition 1): two tests.
  `test_ambient_hook_env_vars_alone_are_completely_inert` sets **every**
  hook's environment variable simultaneously (both symlink-alias-attack
  variables pointed at a real, separately registered victim worktree;
  a forced mid-run failure stage; a seed-mutation instruction; and both
  destination-race variables, including the new one from this pass)
  *without* passing `enable_test_hooks=True`, and asserts the run
  succeeds completely normally end to end: the correct `DEST` is
  produced (verified by exact tree hash), the seed remains clean and
  unmodified, the victim worktree is completely unaffected and still
  registered, and no wrapper temp-path leftovers exist.
  `test_enable_test_hooks_flag_is_hidden_from_help` asserts
  `--help`'s actual output never contains the literal flag string.

### 4. Fixed a real (if narrow) information-hiding gap

Running the new `test_enable_test_hooks_flag_is_hidden_from_help` test
immediately caught that although the `--enable-test-hooks` `argparse`
entry itself correctly used `help=argparse.SUPPRESS` (so it never
appeared in the *options list*), the module's own docstring -- passed
verbatim to `argparse` as the full `--help` description via
`description=__doc__` -- separately spelled out the literal flag name
in prose ("...only ever consulted at all when an explicit, hidden
`--enable-test-hooks` flag is passed..."). Fixed by rewording that
sentence in the module docstring to describe the mechanism without
naming the exact flag string, while keeping the flag name itself
available in code comments (not part of `--help` output) and in this
report, per the task's "keep hidden from normal --help if practical"
instruction. Verified by grepping the actual flag string only appears in
comments and the `argparse` registration itself afterward, and by the
now-passing test.

### 5. Rewrote `README.md`'s Algorithm and Hardening sections; added a new "Second critic review: four conditions" section

- Algorithm steps 6-13 rewritten to describe the actual per-step identity
  re-verification (condition 2), the conservative-config-forced index
  refresh/verification (condition 3), and the explicit post-move
  registration check (condition 4).
- New "Second critic review: four conditions" section added (mirroring
  the existing "Hardening: six areas" section's structure), one
  subsection per condition, each with: the original problem, the exact
  fix and where it lives in the code, and the exact test(s) that falsify
  it -- including condition 4's explicit, honest statement that the race
  is bounded/detect-and-fail-safe, not eliminated, and that **a real
  pilot must use a private (not concurrently writable) parent directory
  for `DEST`** to close that window completely.
- "Limitations" section updated: replaced the old single "races are
  narrowed" bullet with an expanded one covering both residual races
  (seed same-size/mtime/ctime forgery and the destination check-to-move
  window) and the private-parent-directory pilot requirement explicitly,
  plus a new bullet acknowledging that test-only hooks exist in the
  shipped module at all (gated, but present) as a residual for a code
  reviewer to independently confirm.
- Intro paragraph and "Tests" section test counts updated to describe
  both hardening passes and the current 46-test total (42 + 2 + 2 across
  the three test files).

## Files changed and why

- **`bin/cow_worktree.py`**:
  - `move_worktree()`: new `private_gitdir`/`test_hooks_enabled`
    parameters; a new test-only hook call placed inside the genuine
    check-to-move race window; an explicit post-move check that git's
    own trusted registration record now points at `DEST` exactly, not a
    nested subdirectory, raising a specific, explicit `CowError`
    otherwise; a code comment documenting the bounded/non-eliminated
    threat model.
  - `_maybe_create_dest_with_content_race_for_test()`: new test-only
    hook function (writes real foreign content, not just an empty
    directory, into `DEST` inside the race window).
  - `execute_plan()`: updated `move_worktree()` call site to pass the two
    new parameters.
  - Module docstring: removed the literal `--enable-test-hooks` flag
    string from the `--help`-visible description (the earlier gap found
    in item 4 above), rewording without changing the described behavior.
- **`tests/test_cow_worktree.py`**:
  - Added `WRAPPER` to the `helpers` import (needed for the new
    `--help`-inspection test).
  - `TestDestinationTOCTOU`: added
    `test_check_to_move_race_preserves_foreign_content`.
  - Added new class `TestTestHooksDisabledByDefault` with
    `test_ambient_hook_env_vars_alone_are_completely_inert` and
    `test_enable_test_hooks_flag_is_hidden_from_help`.
- **`README.md`**: intro paragraph, Algorithm steps 6-13, a new "Second
  critic review: four conditions" section, "Limitations", and "Tests"
  test counts all updated as described above.
- **`REPORT.md`** (this file): fully rewritten for this pass.
- **No changes** to `tests/fixtures.py`, `tests/helpers.py` (beyond the
  import above -- no, `helpers.py` itself was not modified, only the test
  file's import of it), `tests/test_cross_device.py`,
  `tests/test_partial_clone.py`, or `bench/benchmark.py`: none were in
  scope for these four conditions, and independent review found no
  defects in them relevant to this pass's task.

## Test evidence

```
$ python3 -m py_compile bin/cow_worktree.py tests/*.py bench/benchmark.py
py_compile: OK (0 errors)
```

Targeted run of just the new/changed tests, twice in a row, immediately
after implementing the condition-4 fix and both new test classes:

```
$ python3 -m unittest tests.test_cow_worktree.TestDestinationTOCTOU \
      tests.test_cow_worktree.TestTestHooksDisabledByDefault -v
test_check_to_move_race_preserves_foreign_content ... ok
test_concurrently_created_destination_fails_safely_without_removal ... ok
test_ambient_hook_env_vars_alone_are_completely_inert ... ok
test_enable_test_hooks_flag_is_hidden_from_help ... ok
Ran 4 tests in 9.03s / 7.92s (both runs)
OK (both runs)
```

Full suite, twice in a row:

```
$ python3 -m unittest discover -s tests -p 'test_*.py'
Ran 46 tests in 103.078s
OK

$ python3 -m unittest discover -s tests -p 'test_*.py'
Ran 46 tests in 108.349s
OK
```

`tests/_scratch/` verified empty (`ls tests/_scratch` -> 0 entries) both
immediately before the first full run and immediately after the second,
confirming no cross-run scratch leakage. Breakdown of the 46: 42 in
`tests/test_cow_worktree.py` (up from 40 before this pass -- 2 net new:
`test_check_to_move_race_preserves_foreign_content` and the two new
`TestTestHooksDisabledByDefault` tests, minus zero removed), 2 in
`tests/test_cross_device.py`, 2 in `tests/test_partial_clone.py`.

Manual (non-automated) verification performed before writing the
condition-4 fix/test, exactly as the task instructed ("do not guess"),
entirely in a disposable `/tmp` scratch directory never reused for any
automated test and removed immediately afterward:

- Confirmed `git worktree move` (git 2.54.0) onto a pre-existing
  non-empty destination directory exits `0` and nests the moved worktree
  one level deeper, leaving pre-existing foreign content at the top level
  of that directory completely untouched -- see "What this pass found
  and fixed" #1 above for the exact commands and output.

This pass never read or touched
`/Users/example/go/src/github.com/example-org/monorepo` or
`.../pristine-monorepo`, performed no install/pilot action, and made no
destructive Git operations, network installs, or publishing of any kind.
`tests/helpers.py`'s `_guard()` remains live and unmodified, continuing
to hard-block any automated test path containing either forbidden
substring or falling outside the lab directory.

## Residual risks / blockers (carried forward, plus one new one made explicit)

All residual risks previously disclosed in this lab's history remain
accurate and are now consolidated in `README.md`'s "Limitations" section,
which this pass updated. The one genuinely new item this pass surfaced
and now documents explicitly (rather than leaving implicit) is:

- **A real pilot must place `DEST` under a private (not concurrently
  writable by any other process/user) parent directory.** The
  check-to-move race for `DEST` (condition 4) is detect-and-fail-safe,
  never destructive, but is not atomically eliminated -- `git worktree
  move` exposes no kernel-level primitive that would make the
  existence-check and the move itself atomic with each other. This is a
  hard operational requirement for a real pilot, not merely a
  theoretical footnote.

Everything else -- never run at monorepo scale; the partial-clone
integration test being bounded/local; `SIGKILL`-class interruption
leaving an identifiable-but-not-self-healing orphan; the seed
same-size/mtime/ctime-forgery residual (now also requiring control of
the system clock even under the new hostile-config tests, since those
tests only prove config-poisoning alone doesn't help, not that ctime
forgery is newly prevented); and the benchmark's existing single-sample
caveats -- is unchanged from the prior pass and is not repeated in full
here; see `README.md`.

## Benchmark status

Unchanged from the prior pass; not rerun in this pass (no algorithmic
change to the hot copy/verification path -- this pass's changes are all
in the move/verification and test-injection code, not the per-file
`clonefile(2)` copy loop). Recorded results, carried over unchanged:

| Config | ordinary | CoW | speedup | du (both) |
|---|---|---|---|---|
| 10,000 files x 8,192 bytes | 6.580 s | 5.069 s | 1.30x | 78.1 MiB |
| 50,000 files x 1,024 bytes | 29.660 s | 30.507 s | 0.97x | 195.3 MiB |

Same caveats as before -- see `README.md`'s "Benchmark" section for the
full text.

## Go / no-go for a final read-only critic review

**Go.** All four of the second critic's conditional blockers are now
resolved with dedicated, passing tests: three (conditions 1-3) were
already correctly implemented by a prior attempt at this task and are
independently re-verified here to be correct; the fourth (condition 4)
had a real, concrete gap (a specific race window that was checked-for at
the wrong granularity, with no explicit post-move detection and no test
exercising the genuine window) which this pass fixed with an explicit
detection check plus a new adversarial test proving foreign content
survives byte-for-byte. One additional real defect (a test that was
referenced by name in existing code/doc comments but never actually
written) was found and fixed for condition 1. One small but genuine
information-hiding gap (the hidden flag's literal name leaking into
`--help` output via the module docstring, not the `argparse` entry
itself) was found and fixed. `py_compile` is clean. The full suite (46
tests, up from 40 before this pass) passes cleanly and repeatably, twice
in a row, with no cross-run scratch leakage. `README.md` is updated to
accurately describe the current implementation, map each of the four
conditions to its fix and test, and explicitly, honestly document the
one race that remains bounded-but-not-eliminated together with the
private-parent-directory requirement a real pilot must satisfy. This
remains, and should continue to be presented as, an experimental lab
tool never run against a real repository -- not a production-ready
patch.
