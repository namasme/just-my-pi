# Pi `/report` extension

A global, deterministic Pi command that creates a Beads bug containing diagnostic
metadata for the current session. It does not call an LLM and does not copy the
transcript.

## Behavior

- `/report` opens a multiline editor.
- Text after `/report` prefills the editor.
- The first non-empty line is the bead title; the rest is the user description.
- If an agent run is active, capture waits until Pi is idle.
- Reports are P2 bugs labeled `pi-report`.
- The bead references the session JSONL path, session ID, and active leaf.
- Extended runtime, entry-count, active-tool, extension-source, and Git metadata
  are stored in the bead.
- Each successful report updates `.beads/issues.jsonl` and creates a local Git
  commit named `report: <issue-id>`.
- Repository and global Git hooks are disabled for setup and report commits.
- Nothing is pushed automatically.

The command is intentionally TUI-only. It makes no model calls and requires no
model credentials or network access.

## Install

```bash
cd ~/pi/extensions/report
./install-link.sh
./setup-tracker.sh
```

Then run `/reload` in an existing Pi session. New sessions discover the extension
automatically from `~/.pi/agent/extensions/report`.

The tracker defaults to `~/pi/reports`. For isolated testing, both scripts and the
extension honor `PI_REPORT_TRACKER_DIR`.

## Usage

```text
/report
/report Reload loses the selected model
```

If the tracker is missing, `/report` stops and points to `setup-tracker.sh`; it
never initializes repositories implicitly.

## Tests

```bash
bun run test
```

The integration test installs a deliberately malicious global `post-commit` hook
and verifies that neither tracker setup nor report-shaped commits execute it.
The `/triage-report` test suite (`triage-runtime.test.ts`) creates several real,
disposable `bd`/Git trackers via `setup-tracker.sh` and can take **a couple of
minutes** to run — that is expected Dolt/Beads startup overhead per fixture, not
a hang. No test in this package makes a model or network call; the inner
investigator is always a fake function in tests.

## Failure behavior

If bead creation succeeds but export or Git commit fails, the command reports the
created bead ID and exact deterministic recovery commands. A dirty tracker export
blocks subsequent reports so multiple issues cannot be folded silently into one
commit. The transcript is only referenced and is never modified or copied.

## `/triage-report`: automated read-only investigation of open reports

`/triage-report` runs **one** bounded triage pass over open `pi-report` tickets
in the same tracker. Each pass:

1. Deterministically picks **at most one** eligible open report (no model call
   if there is nothing to do).
2. Claims it in Beads, then launches a **fresh, read-only, offline, headless
   Pi subprocess** to investigate it.
3. Posts the investigator's findings — or, if the investigator produced only
   empty/whitespace-only text, a diagnostic audit note instead — as a comment,
   labels the ticket `triage:needs-review`, and returns it to `open` — it
   never closes a ticket.

It is designed to be invoked either manually (`/triage-report` in an interactive
session) or unattended on a schedule via [`pi-tick`](https://www.npmjs.com/package/pi-tick)
or an equivalent scheduler, and it is safe either way: no eligible candidate, a
paused state, a dirty tracker, or a claim that isn't actually stale all skip the
model call entirely.

### Commands

| Command | Effect |
|---|---|
| `/triage-report` or `/triage-report run` | Run one triage pass. |
| `/triage-report status` | Reports the tracker path, paused state, eligible-candidate count, and active `pi-triage` claims. It makes no logical tracker change; it may restore the committed empty JSONL export if a Beads 1.0 read removed that file. |
| `/triage-report pause` | Set a kill-switch flag. Future passes return immediately without touching Beads/Git. Existing claims are left as-is. |
| `/triage-report resume` | Clear the pause flag. |

A run immediately emits a start notice and shows a persistent `triage:` footer
status in TUI/RPC sessions while it is active. Once a ticket is safely claimed,
it emits a second notice with the ticket ID and attempt number before awaiting
the potentially multi-minute investigator. The footer status is cleared on
completion or failure, and the normal outcome notice follows.

### Eligibility and ordering

A candidate must be: a `bug`, `status=open`, labeled `pi-report`, have
`metadata.source=pi-report`, and have **none** of `triage:claimed`,
`triage:needs-review`, `triage:blocked`, or `triage:transcript-missing`. Among
eligible tickets, the highest priority (lowest `P` number) wins; ties break by
oldest `created_at`, then issue ID. Exactly one ticket is processed per pass.

### Claim protocol

- Claims reuse the same `.pi-report.lock` file `/report` uses to serialize
  their normal mutation paths. The lock is held only for the short
  claim/finalize Beads+Git phases — **not** while the investigator is running.
  It uses ownership tokens and stale-lock recovery, but remains a local
  filesystem coordination mechanism rather than a distributed lock or a
  complete defense against hostile replacement of lock files.
- A claim is `bd update <id> --claim` (native, conflict-checked; a different
  assignee makes the call fail loudly) plus `bd set-state <id> triage=claimed`
  (adds the `triage:claimed` label and a durable Beads event). The actor is
  always the fixed string `pi-triage`.
- The claim also stamps additive `--set-metadata` fields — `triageRunId`,
  `triageAttempt`, `triageClaimedAt` — without touching the original report
  metadata written by `/report`.
- After claiming, the code **reads the issue back** and verifies its status,
  assignee, `triage:claimed` label, run ID, attempt, and claim timestamp; it
  never trusts its own claim call blindly. It validates ownership again after
  investigation and will not finalize over human intervention or another run.
- Before any mutation, the tracker's Git worktree/index must be clean (beyond
  the gitignored lock file itself). A dirty tracker aborts the whole pass with
  no changes, matching `/report`'s own safety rule.

### Stale-claim recovery and retry limits

If a previous pass crashed or was interrupted mid-investigation, the *next*
pass first checks for its own active claim (`assignee=pi-triage`,
`status=in_progress`). If that claim's `triageClaimedAt` is older than the
lease (default 15 minutes, `PI_TRIAGE_LEASE_MS`), it is recovered: the same
`triageRunId` is kept (so a duplicate finding never gets posted twice, see
below) and `triageAttempt` is incremented. After `PI_TRIAGE_MAX_ATTEMPTS`
(default 3) attempts — whether from staleness or investigator failure — the
ticket is labeled `triage:blocked` with an explanatory comment and returned to
plain `open`, and will not be re-selected until a human clears the label (or
the `triageAttempt` metadata).

### Comment de-duplication and growth cap

Every automated comment ends with a stable marker line
(`pi-triage: run=<id> attempt=<n> sha256=<hex>`). Before posting, the code
checks whether a comment for the *same run id* already exists (crash-safe
idempotency: a retried finalize step never double-posts) and whether the
ticket has already reached `PI_TRIAGE_MAX_COMMENTS` (default 3) automated
comments; either condition skips posting without failing the pass.

### What the investigator can and cannot do

The investigator is a **separate, disposable-per-call Pi process**, launched
only after a successful claim, with:

```text
pi --mode json --session-dir <investigator sessions dir> --session-id <safe id> \
   --no-extensions --no-skills --no-prompt-templates --no-themes \
   --no-context-files --no-approve --offline --no-tools \
   [--model <PI_TRIAGE_MODEL>] "<bounded prompt>"
```

- **No model tools.** The investigator receives no `bash`, filesystem,
  mutation, extension, or network tools. Trusted extension code supplies a
  bounded transcript excerpt and repository-state facts before launch, so the
  model cannot reopen a transcript path that changes after validation. The
  supplied report and excerpt are still sent to the configured model provider;
  run unattended triage in an OS/container sandbox if that disclosure risk is
  unacceptable.
- **No model-controlled Beads/Git mutation.** All Beads and Git mutation
  happens in trusted extension code, never inside the model's tool loop. The
  investigator's entire output is captured as plain text and used only as
  comment *content* — never interpreted as a command.
- **Untrusted input, explicitly labeled.** The ticket description, existing
  comments, and transcript excerpt are wrapped between
  `BEGIN/END UNTRUSTED REPORT DATA` markers with an explicit instruction to
  ignore embedded instructions. Prompt injection remains possible and can
  mislead the findings, but the investigator has no tools with which to read
  additional files or execute tracker/repository mutations.
- **Bounded, validated transcript context.** The recorded transcript must
  resolve to a readable regular file under Pi's trusted sessions directory;
  missing, unsafe, directory, and escaping-symlink paths are rejected without
  a model call. Trusted code opens and validates the same handle from which it
  reads bounded bytes. Prompt framing and the closing untrusted-data sentinel
  survive truncation; lower-priority report data, including repository facts,
  may be omitted to stay within the hard prompt cap.
- **Model selection.** Set `PI_TRIAGE_MODEL` to pin a specific model
  (`provider/id`, fuzzy names resolve the same way other Pi model flags do).
  If unset, the investigator uses Pi's normal default model — the same one an
  interactive session would use.

#### Investigator session persistence, auditability, and retention

Each investigator invocation runs with `--mode json` (a structured JSONL event
stream on stdout, not plain text) into a **persistent, dedicated, private**
session directory — `~/.pi/agent/pi-report-triage/investigator-sessions/` by
default (following `PI_CODING_AGENT_DIR`), never a human's own interactive
session directory or history/picker — under an explicit, safe session id
correlated to that triage run and attempt (`pi-triage-<runId>-a<attempt>`).
This replaces the previous ephemeral `--no-session` invocation:

- **Traceable.** Every finalized/blocked/failed/empty-findings automated
  comment embeds a bounded audit block with that exact `sessionId` and the
  resolved `sessionFile` path, plus the investigator's process exit
  code/killed flag, `stopReason`, a bounded error message, stdout/stderr byte
  counts and SHA-256 hashes, bounded stdout/stderr excerpts, and a count of
  any malformed JSONL lines encountered while parsing the stream. The audit
  block never duplicates the prompt text itself and never carries full
  stdout/stderr; the persisted Pi session file is the complete local audit
  source.
  - The `sessionFile` in that audit block is only ever attributed after this
    extension opens the discovered file with a bounded, **head-only** read
    and confirms *only its first line* parses as a Pi session header whose
    `id` matches the exact id explicitly requested via `--session-id`; a
    mismatch, an unreadable/unparseable first line, or (per the persistence
    guarantee below) no discoverable file at all is treated as an
    investigator failure, never silently accepted as a successful
    attribution. A bad first line followed by a coincidentally matching
    "session"-shaped object further down the file is never trusted either —
    only the first line is ever inspected.
  - Every free-form scalar rendered into the audit block — `stopReason` and
    `errorMessage` (which come straight from the investigator's own output,
    so nothing about their length or content is under this extension's
    control) as well as `sessionId`/`sessionFile` (which this extension
    constructs/resolves itself) — is bounded and rendered single-line- and
    Markdown-fence-safe before it ever reaches a comment: embedded newlines
    can't split one field across multiple rendered lines, and embedded
    triple-backtick runs can't break out of the block's own fenced code
    block. `stopReason`/`errorMessage` are capped small (500 chars); the
    deterministic `sessionId`/`sessionFile` fields get a much larger,
    practically-never-hit ceiling (2,000 chars) so they stay fully useful
    rather than being aggressively truncated. Truncation, on the rare fields
    where it can happen, always carries an explicit marker recording the
    original length — never silent. Stdout/stderr excerpts are also capped
    again at the tracker-rendering boundary. Embedded backtick-fence runs are
    neutralized while line structure remains readable, so an excerpt cannot
    escape its own fenced block or forge surrounding comment structure.
  - The byte counts and hashes are metadata about `pi.exec`'s already-decoded
    stdout/stderr **strings**, re-encoded as UTF-8 — not a guarantee of
    byte-for-byte fidelity to the raw bytes the investigator process wrote to
    its OS pipes. If the process ever emitted invalid UTF-8, Node's decoding
    (inside `pi.exec`) may already have substituted replacement characters
    before this code ever sees the string; this extension does not redesign
    around raw `Buffer`s, since `pi.exec`'s API surface only exposes decoded
    strings.
- **Inspectable.** Given a `sessionFile` from an audit block, open the exact
  investigator run directly and read-only, e.g. `pi --session <sessionFile>`
  (or just read the JSONL file), to see everything the model actually saw and
  said for that specific attempt — independent of, and strictly more complete
  than, the bounded audit block posted to the ticket.
- **Guaranteed.** Every *successful* investigator attempt is persisted: an
  investigator process that exits `0` but has no attribution-verified session
  file to show for it is treated as a **failure**, not a success with
  `sessionFile: null`. This is the core auditability goal of this whole
  mechanism — a completed, `completed`/needs-review-labeled finding must
  always be traceable back to a real, verified session file; there is no
  "successful but unauditable" outcome. A nonzero process exit (or a killed
  process) is, as always, unconditionally a failure regardless of any of
  this — the session-file check only ever applies to an otherwise-clean
  exit `0`.
- **Privacy.** These session files contain the full bounded prompt (ticket
  title/description/comments, the transcript excerpt, and repository facts)
  and the model's full response, i.e. the same untrusted/sensitive data the
  prompt itself carries (see the disclosure note above) — persisted to local
  disk under `PI_CODING_AGENT_DIR` rather than discarded immediately after the
  call. Treat this directory with the same sensitivity as `PI_TRIAGE_SESSIONS_DIR`
  itself; it is never uploaded, synced, or shared by this extension.
- **Retention.** After every investigator call, the directory is pruned
  best-effort to the newest `PI_TRIAGE_INVESTIGATOR_SESSION_RETENTION` (default
  `200`) session files, oldest first, by filename (Pi's own
  `<ISO-8601>_<sessionId>.jsonl` convention, which sorts lexicographically in
  chronological order). Pruning failures are swallowed and never fail a triage
  pass; only files directly inside this dedicated directory are ever touched.
- **Backfilling.** There is no way to retroactively recover a session for a
  triage attempt that ran *before* this change: those investigator processes
  used `--no-session` and produced no persisted session file at all, so
  nothing exists to backfill for them. Going forward, every new investigator
  attempt is always captured this way; if you need to keep an investigation's
  session file indefinitely (past the retention cap), copy it out of the
  dedicated directory before it ages out — the automated comment's audit block
  is your indicator of exactly which file that is.

### Reviewing what triage found

```bash
cd ~/pi/reports
bd list --label pi-report --status open --label triage:needs-review
```

A ticket only leaves this queue when a human clears the label (typically by
closing it, or by removing `triage:needs-review` to let it be reconsidered).

### Pause / kill switch

`/triage-report pause` writes a small flag file **outside** the tracker
(`~/.pi/agent/pi-report-triage/paused` by default, following
`PI_CODING_AGENT_DIR`) so pausing can never make the tracker's Git worktree
look dirty. `/triage-report resume` removes it. While paused, every pass
returns the `paused` outcome immediately — no Beads query, no Git call, no
model call.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PI_REPORT_TRACKER_DIR` | `~/pi/reports` | Same tracker override `/report` uses. |
| `PI_TRIAGE_LEASE_MS` | `900000` (15 min) | How long a claim may sit `in_progress` before the next pass may recover it. |
| `PI_TRIAGE_MAX_ATTEMPTS` | `3` | Attempts (fresh + recovered) before a ticket is marked `triage:blocked`. |
| `PI_TRIAGE_MAX_COMMENTS` | `3` | Cap on automated (marker-bearing) comments per ticket. |
| `PI_TRIAGE_TIMEOUT_MS` | `300000` (5 min) | Wall-clock timeout for the inner investigator process. |
| `PI_TRIAGE_MODEL` | unset | Optional model id for the investigator; unset uses Pi's normal default model. |
| `PI_TRIAGE_TRANSCRIPT_CAP_BYTES` | `2000000` | Maximum transcript bytes trusted code reads before constructing a bounded head/tail excerpt. |
| `PI_TRIAGE_SESSIONS_DIR` | `~/.pi/agent/sessions` | Trusted root under which recorded transcript paths must resolve; symlink escapes and non-regular files are rejected. |
| `PI_TRIAGE_INVESTIGATOR_SESSION_RETENTION` | `200` | How many investigator session files (newest-first) are retained under the dedicated investigator session directory; older ones are pruned after each investigator call. |
| `PI_TRIAGE_HEADLESS_EXIT_ON_FAILURE` | enabled | Kill switch for the headless/scheduled failure-visibility policy (see [Headless/scheduled failure visibility](#headlessscheduled-failure-visibility-pi-tick) below). Set to `0`, `false`, `no`, or `off` (case-insensitive) to disable; any other value, including unset, keeps it enabled. |

Invalid or empty values fall back to the default; they never error the command.

### Headless/scheduled failure visibility (pi-tick)

As verified against Pi 0.84.1, neither of the two non-interactive dispatch
paths `/triage-report` can run under naturally reflects a failed pass into the
process's own exit code: Pi's RPC-mode shutdown path **hardcodes exit 0**
regardless of what happened during the run, and plain print mode (`pi -p`)
never threads an extension command's own outcome into its exit code at all.
A scheduler like `pi-tick` that only watches the process exit code would
otherwise never notice that a scheduled `/triage-report` pass failed.

To make that visible, every outcome other than `completed`, `no-candidate`,
`claim-in-progress`, and `paused` (the deliberately benign/no-op set) —
including `tracker-not-ready`, `lock-timeout`, `dirty`, `transcript-missing`,
`blocked`, `failed-attempt`, `deferred`, `ownership-lost`, the empty-findings
outcome above, a `PartialTriageError`, any other caught error, and an
**unrecognized/misspelled subcommand** (e.g. a `pi-tick` job whose prompt has
a typo like `/triage-report rnu`) — makes `/triage-report` force a nonzero
process exit **after** every required tracker mutation/commit and UI-status
cleanup for that pass have already completed:

1. One synchronous, bounded `Error: ...` line is written directly to stderr
   (via `fs.writeSync`, never a buffered/async write that a subsequent
   `process.exit()` could drop).
2. The process then calls `process.exit(1)` directly, deliberately bypassing
   both of the exit-code gaps described above.

This only ever applies **outside an interactive TUI session** — `ctx.mode ===
"tui"` is never terminated by this policy, regardless of outcome or the kill
switch below, so running `/triage-report` manually in a normal Pi session
never risks an unexpected process exit. It applies uniformly to every
non-TUI dispatch mode (`rpc`, `json`, `print`), so it covers `pi-tick`'s own
RPC dispatch as well as `pi --mode json`/`pi -p` invocations.

Set `PI_TRIAGE_HEADLESS_EXIT_ON_FAILURE=0` (or `false`/`no`/`off`) to disable
this forced exit entirely if it doesn't fit how you monitor `pi-tick` — the
run still completes and notifies exactly as before, it just never forces a
nonzero exit code on its own.

### Proposed `pi-tick` schedule (not installed by this change)

This change does **not** install, enable, or schedule anything. To run
`/triage-report` unattended every 5 minutes once you're ready, the shape would
be:

```bash
pi-tick add triage-report \
  --prompt "/triage-report" \
  --cwd ~/pi/reports \
  --kind interval --minutes 5
# job is created disabled; verify manually before enabling:
pi-tick run triage-report
pi-tick show triage-report
# only once you're satisfied:
pi-tick enable triage-report
```

`pi-tick` runs `/`-prefixed prompts through Pi's RPC mode rather than as a
model-interpreted message, which is exactly the dispatch path `/triage-report`
is designed for (see [Commands](#commands) above; the command does not require
an interactive TUI). A pass that hits a non-benign outcome makes that RPC
invocation exit nonzero (see
[Headless/scheduled failure visibility](#headlessscheduled-failure-visibility-pi-tick)
above), so `pi-tick`'s own job-history/exit-code tracking reflects a failed
scheduled pass instead of always reporting success.

### macOS manual/TCC preflight

Before enabling any scheduled job, run it once manually so macOS can ask about
any permission prompts a launchd-spawned process cannot show on its own
(`pi-tick run <id>`, or just `/triage-report` once interactively). This matters
for the trusted extension process reading the recorded transcript and querying
Git state in a reported repository under `~/`, `~/Documents`, or similar
TCC-protected locations; the investigator model itself receives no tools.

### Safety summary

- Same actor (`pi-triage`), same tracker, same lock file, same hook-suppressed
  path-limited commit convention as `/report`.
- Never closes a ticket, never uses a custom Beads status, never runs `bd
  close`.
- The model gets no tools, never talks to Beads or Git directly, and its
  output is only ever used as comment text.
- No eligible candidate, a paused state, a dirty tracker, or a non-stale
  existing claim all skip the model call entirely, keeping a 5-minute schedule
  cheap when there is nothing to do.
- Empty or Unicode-whitespace-only investigator text is **never** treated as
  a successful finding: it takes a distinct, no-retry `finalized-empty` path
  (a diagnostic audit comment, `triage:needs-review`, released to `open`)
  instead of being posted as a placeholder "success".
- Every investigator invocation is captured with a persistent, dedicated,
  private session (see
  [Investigator session persistence, auditability, and retention](#investigator-session-persistence-auditability-and-retention)
  above) and a bounded, structured audit block on the resulting comment —
  never the raw prompt duplicated onto the ticket, and never unbounded
  stdout/stderr.
- A non-benign outcome forces a visible, nonzero exit for headless/scheduled
  invocations (see
  [Headless/scheduled failure visibility](#headlessscheduled-failure-visibility-pi-tick)
  above) — but never for an interactive TUI session.
