// IO layer + orchestration for /triage-report. Pure decision logic lives in
// triage-core.ts; this file wires it to bd/git subprocesses, the filesystem,
// and the inner read-only investigator process through an injectable
// `TriageDeps` bundle so tests can supply fakes for the investigator (never a
// real model/network call) while still exercising real bd/git against
// disposable temporary trackers.

import { access, constants as fsConstants, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHardenedCommitArgs, isDirectory, restoreBenignEmptyExportDeletion, withTrackerLock } from "./report-core.ts";
import {
  type BdComment,
  type BdIssue,
  BD_EXPORT_ARGS,
  type ClaimedCandidate,
  GIT_ADD_ISSUES_ARGS,
  type InvestigatorAudit,
  type RepoFact,
  type TriageConfig,
  type TriageOutcome,
  appendRunMarker,
  bdCandidatesArgs,
  bdClaimArgs,
  bdCommentAddArgs,
  bdCommentsListArgs,
  bdOwnActiveClaimsArgs,
  bdRefreshClaimArgs,
  bdReleaseArgs,
  bdSetStateArgs,
  bdShowArgs,
  blockedReason,
  boundedTextExcerpt,
  buildBlockedNote,
  buildEmptyFindingsNote,
  buildInvestigationPrompt,
  buildInvestigatorSessionId,
  buildTranscriptMissingNote,
  claimReason,
  claimVerified,
  commandError,
  compareGitState,
  emptyFindingsReason,
  excerptTranscript,
  formatAuditBlock,
  getRecordedGit,
  getTranscriptPath,
  getTriageAttempt,
  getTriageRunId,
  hasClaimedLabel,
  hasExceededMaxAttempts,
  hasExistingRunComment,
  isAutomatedCommentCapReached,
  isBlankInvestigatorText,
  isClaimStale,
  isOwnActiveClaim,
  isWithinTrustedRoot,
  needsReviewReason,
  parseBdJsonArray,
  parseInvestigatorJsonl,
  parseSessionHeaderLine,
  selectCandidate,
  selectInvestigatorSessionFilesForPruning,
  sha256Hex,
  stillOwnsClaim,
  transcriptMissingReason,
  type CurrentGit,
  type TranscriptExcerpt,
} from "./triage-core.ts";

const COMMAND_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 10_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

export interface InvestigatorResult {
  ok: boolean;
  text: string;
  error?: string;
  /**
   * Bounded, structured audit data for this attempt (see `InvestigatorAudit`
   * in triage-core.ts). Optional so existing/fake investigators used in
   * tests continue to satisfy this type without change; when absent,
   * finalization notes fall back to a "(none captured)" audit block rather
   * than failing. `makeRealInvestigator` always populates this.
   */
  audit?: InvestigatorAudit;
}

export type InvestigatorFn = (
  prompt: string,
  opts: { cwd: string; timeoutMs: number; model?: string; runId: string; attempt: number },
) => Promise<InvestigatorResult>;

export interface TriageRuntimeDeps {
  exec: ExecFn;
  trackerDir: string;
  emptyHooksDir: string;
  config: TriageConfig;
  now: () => number;
  nowIso: () => string;
  newRunId: () => string;
  /**
   * Single combined check-and-read for a recorded transcript path: resolves
   * and confirms the path is inside the trusted session-transcript root,
   * opens it, uses the *opened handle's* fstat to confirm it is a regular
   * file, and reads at most `maxBytes` bytes total (head+tail) from that
   * same handle. Returns `null` for every failure mode alike (missing,
   * wrong type, outside the trusted root, unreadable) — callers must treat
   * that identically to "no transcript" and never invoke the model.
   *
   * There is deliberately no separate boolean "is this usable" pre-check
   * followed by a later, independent open elsewhere in this file: ticket
   * metadata is not fully trusted input (it can be edited by anyone with
   * tracker write access) by the time a triage pass runs, and a path that
   * passes a check at one moment is not guaranteed to still point at the
   * same, safe file by the time a later, separate open would run — the
   * investigator can take minutes, and this deps function is only ever
   * called once, at claim time, with its result carried forward (see
   * `ClaimedCandidate.transcriptExcerpt`) rather than re-read.
   */
  readTranscriptIfUsable: (path: string, maxBytes: number) => Promise<string | null>;
  isPaused: () => Promise<boolean>;
  investigate: InvestigatorFn;
  notify: (message: string, level: "info" | "warning" | "error") => void;
}

/**
 * Thrown when at least one Beads mutation already landed successfully in the
 * current operation, and a *subsequent* step in that same operation (another
 * Beads write, or the git export/add/commit) then failed. This is always a
 * partial, disk-visible state that a human (or the next pass, via the dirty
 * check) needs to know about with the specific issue ID attached — never a
 * plain `Error` that a caller might treat as "nothing happened" and silently
 * retry over.
 */
export class PartialTriageError extends Error {
  constructor(
    readonly id: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Centralized mutation/commit protocol for a single logical triage
 * operation (claim, transcript-missing, blocked, findings, ...). Once any
 * write in the ledger has landed successfully, every subsequent failure in
 * that same ledger is escalated to `PartialTriageError` instead of a plain
 * `Error` — closing the "successful write followed by a swallowed or
 * mis-classified downstream failure" window regardless of which specific
 * bd/git call fails. Never construct more than one ledger per logical
 * operation, and never let a later, unrelated operation reuse an earlier
 * one's ledger: that would let it silently absorb an earlier partial state.
 */
export class MutationLedger {
  private landed = false;

  /** Record that a write has landed (used when the write's own result was already checked another way). */
  markLanded(): void {
    this.landed = true;
  }

  /** True once a write has landed in this ledger — used by callers that need to escalate a *read* failure, not just a write failure, once a mutation is already durably on disk. */
  hasLanded(): boolean {
    return this.landed;
  }

  /** Check a `bd`/`git` result: throws on failure, escalating to `PartialTriageError` once something has already landed. */
  guard(id: string, description: string, res: ExecResult): void {
    if (res.code === 0) {
      this.landed = true;
      return;
    }
    const err = commandError(description, res.code, res.stderr, res.stdout);
    if (this.landed) throw new PartialTriageError(id, err.message);
    throw err;
  }
}

/**
 * A `MutationLedger` for an operation that only ever runs against a ticket
 * that *already* carries a durably-landed mutation from an earlier,
 * completed operation (e.g. finalizing a claim that was committed in a
 * previous locked section, or handling a stale claim that a previous run
 * already claimed and committed). Pre-marking it landed means any read
 * failure this operation hits — not just a write failure — is correctly
 * escalated to `PartialTriageError` rather than a plain `Error`: the ticket
 * is already in a real, disk-visible non-default state, so a read failure
 * here is exactly the kind of partial/uncertain situation a human needs to
 * know about, never something a caller can shrug off as "nothing happened".
 */
function preLandedLedger(): MutationLedger {
  const ledger = new MutationLedger();
  ledger.markLanded();
  return ledger;
}

/**
 * Runs `fn`; if it throws and `ledger` has already landed a mutation,
 * re-throws as `PartialTriageError(id, ...)` instead of the original error.
 * Used to escalate *read* failures (bd show, bd comments, ...) that happen
 * after a write has already landed in the same logical operation — those
 * reads matter just as much as writes for detecting a partial state, and
 * must never surface as a plain, silently-absorbable `Error` once something
 * has already changed on disk.
 */
async function escalate<T>(ledger: MutationLedger, id: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (ledger.hasLanded()) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PartialTriageError(id, message);
    }
    throw error;
  }
}

// ─── Small exec-wrapping helpers ────────────────────────────────────────────

async function bd(deps: TriageRuntimeDeps, args: string[], timeout = COMMAND_TIMEOUT_MS) {
  return deps.exec("bd", args, { cwd: deps.trackerDir, timeout });
}

async function git(deps: TriageRuntimeDeps, args: string[], timeout = GIT_TIMEOUT_MS) {
  return deps.exec("git", args, { cwd: deps.trackerDir, timeout });
}

/**
 * Reads an issue back by id. Throws (never silently returns `null`) both on
 * a failing `bd show` invocation and on unparseable JSON output — a `bd
 * show` that fails outright is just as much a read failure as one that
 * returns garbage, and callers that only care about "not found" (an empty
 * result array) still get that as a plain `null`. Callers that read an
 * issue back *after* a write has already landed must wrap this call in
 * `escalate(...)` so a thrown failure here is correctly promoted to
 * `PartialTriageError` instead of leaking a plain `Error` (or, worse, being
 * caught and downgraded to a misleading outcome like `no-candidate`).
 */
async function showIssue(deps: TriageRuntimeDeps, id: string): Promise<BdIssue | null> {
  const res = await bd(deps, bdShowArgs(id));
  if (res.code !== 0) throw commandError("bd show", res.code, res.stderr, res.stdout);
  try {
    const values = parseBdJsonArray(res.stdout) as BdIssue[];
    return values[0] ?? null;
  } catch (error) {
    throw new Error(
      `bd show returned unparseable JSON for ${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function listComments(deps: TriageRuntimeDeps, id: string): Promise<BdComment[]> {
  const res = await bd(deps, bdCommentsListArgs(id));
  if (res.code !== 0) throw commandError("bd comments", res.code, res.stderr, res.stdout);
  try {
    return parseBdJsonArray(res.stdout) as BdComment[];
  } catch (error) {
    throw new Error(
      `bd comments returned unparseable JSON for ${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function listCandidates(deps: TriageRuntimeDeps): Promise<BdIssue[]> {
  const res = await bd(deps, bdCandidatesArgs());
  if (res.code !== 0) throw commandError("bd list", res.code, res.stderr, res.stdout);
  return parseBdJsonArray(res.stdout) as BdIssue[];
}

async function listOwnActiveClaims(deps: TriageRuntimeDeps): Promise<BdIssue[]> {
  const res = await bd(deps, bdOwnActiveClaimsArgs());
  if (res.code !== 0) throw commandError("bd list", res.code, res.stderr, res.stdout);
  return parseBdJsonArray(res.stdout) as BdIssue[];
}

async function isTrackerDirty(deps: TriageRuntimeDeps): Promise<boolean> {
  // Best-effort auto-heal of a known Beads 1.0 quirk (see report-core.ts)
  // before doing the real dirty check, so the `no-candidate`/`status` paths
  // of a freshly initialized (zero-issue) tracker don't get permanently
  // stuck behind a false "dirty" verdict. If this can't determine anything
  // useful, it changes nothing and the check below still runs.
  await restoreBenignEmptyExportDeletion(deps.exec, deps.trackerDir, GIT_TIMEOUT_MS).catch(() => false);

  const res = await git(deps, ["status", "--porcelain"]);
  if (res.code !== 0) throw commandError("git status", res.code, res.stderr, res.stdout);
  const dirty = res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // The report/triage lock file lives inside the tracker dir but must
    // never be committed; it should already be gitignored, but never rely
    // on that alone for a safety check.
    .filter((line) => !line.endsWith(".pi-report.lock"));
  return dirty.length > 0;
}

async function commitStateChange(deps: TriageRuntimeDeps, id: string, message: string): Promise<void> {
  const exported = await bd(deps, BD_EXPORT_ARGS);
  if (exported.code !== 0) {
    throw new PartialTriageError(
      id,
      commandError("bd export", exported.code, exported.stderr, exported.stdout).message,
    );
  }
  const added = await git(deps, GIT_ADD_ISSUES_ARGS);
  if (added.code !== 0) {
    throw new PartialTriageError(id, commandError("git add", added.code, added.stderr, added.stdout).message);
  }
  await mkdir(deps.emptyHooksDir, { recursive: true });
  const committed = await git(deps, buildHardenedCommitArgs(deps.emptyHooksDir, message), COMMAND_TIMEOUT_MS);
  if (committed.code !== 0) {
    await git(deps, ["reset", "--", ".beads/issues.jsonl"]);
    throw new PartialTriageError(
      id,
      commandError("git commit", committed.code, committed.stderr, committed.stdout).message,
    );
  }
}

async function writeTrustedTempFile(text: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-triage-"));
  const path = join(dir, "comment.md");
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Posts `bodyText` as a marker-bearing automated comment unless a comment for
 * this exact run already exists (crash-safe dedup) or the automated-comment
 * cap has been reached (growth guard). Never throws on a cap hit; the caller
 * still proceeds to whatever state transition it was going to make.
 *
 * `ledger` defaults to a fresh, single-use ledger so this remains directly
 * callable on its own (e.g. in tests), but every in-process caller that
 * performs further writes in the same logical operation must pass its own
 * shared ledger so a comment-add failure after an earlier successful write
 * is correctly escalated to `PartialTriageError`.
 */
export async function postAutomatedComment(
  deps: TriageRuntimeDeps,
  id: string,
  runId: string,
  attempt: number,
  bodyText: string,
  ledger: MutationLedger = new MutationLedger(),
): Promise<{ posted: boolean; skippedReason?: string }> {
  // If a write has already landed in `ledger` by the time this runs (the
  // common case: every in-process caller passes its own operation's shared,
  // already-landed-or-about-to-land ledger), a failure reading comments
  // back here — needed for crash-safe dedup and the comment cap — is itself
  // a partial/uncertain state, not a plain, silently-absorbable `Error`.
  const comments = await escalate(ledger, id, () => listComments(deps, id));
  if (hasExistingRunComment(comments, runId)) {
    return { posted: false, skippedReason: "already posted for this run" };
  }
  if (isAutomatedCommentCapReached(comments, deps.config.maxAutomatedComments)) {
    return { posted: false, skippedReason: "automated comment cap reached" };
  }
  const body = appendRunMarker(bodyText, runId, attempt, sha256Hex(bodyText.trim()));
  const temp = await writeTrustedTempFile(body);
  try {
    const res = await bd(deps, bdCommentAddArgs(id, temp.path));
    ledger.guard(id, "bd comments add", res);
  } finally {
    await temp.cleanup();
  }
  return { posted: true };
}

// ─── Repo facts + investigator cwd ─────────────────────────────────────────

async function currentGitFacts(deps: TriageRuntimeDeps, root: string): Promise<CurrentGit | null> {
  const rootCheck = await deps.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    timeout: GIT_TIMEOUT_MS,
  });
  if (rootCheck.code !== 0) {
    throw commandError("git rev-parse --show-toplevel", rootCheck.code, rootCheck.stderr, rootCheck.stdout);
  }
  const [branch, head, status] = await Promise.all([
    deps.exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, timeout: GIT_TIMEOUT_MS }),
    deps.exec("git", ["rev-parse", "HEAD"], { cwd: root, timeout: GIT_TIMEOUT_MS }),
    deps.exec("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
    }),
  ]);
  if (head.code !== 0) {
    throw commandError("git rev-parse HEAD", head.code, head.stderr, head.stdout);
  }
  if (status.code !== 0) {
    throw commandError("git status", status.code, status.stderr, status.stdout);
  }
  return {
    root: rootCheck.stdout.trim(),
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
    head: head.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
  };
}

async function gatherRepoContext(
  deps: TriageRuntimeDeps,
  issue: BdIssue,
): Promise<{ facts: RepoFact[]; investigatorCwd: string }> {
  const recorded = getRecordedGit(issue);
  const candidateRoot = recorded?.root;
  const rootUsable = candidateRoot ? await isDirectory(candidateRoot) : false;

  if (!rootUsable) {
    const facts: RepoFact[] = recorded
      ? [
          {
            label: "repository",
            value: `recorded at ${recorded.root ?? "unknown"} but that path is not currently accessible from this machine`,
          },
        ]
      : [{ label: "repository", value: "no repository was recorded on this report" }];
    return { facts, investigatorCwd: deps.trackerDir };
  }

  const current = await currentGitFacts(deps, candidateRoot as string);
  return { facts: compareGitState(recorded, current), investigatorCwd: candidateRoot as string };
}

// ─── Claim establishment (shared by fresh + stale-recovery paths) ─────────

async function establishClaim(
  deps: TriageRuntimeDeps,
  args: { id: string; runId: string; attempt: number; isFresh: boolean },
  ledger: MutationLedger,
): Promise<BdIssue | null> {
  const nowIso = deps.nowIso();
  const claimArgs = args.isFresh
    ? bdClaimArgs(args.id, args.runId, args.attempt, nowIso)
    : bdRefreshClaimArgs(args.id, args.runId, args.attempt, nowIso);
  const res = await bd(deps, claimArgs);
  if (res.code !== 0) {
    deps.notify(
      `/triage-report: could not claim ${args.id}: ${(res.stderr || res.stdout).trim()}`,
      "info",
    );
    return null;
  }
  // The claim write itself landed regardless of whether the read-back below
  // verifies cleanly; any later failure in this ledger — including a read
  // failure, not just a write failure — must now be treated as a partial-
  // state window, not a plain, silently-absorbable error or a misleading
  // `no-candidate`/`null` that implies nothing happened.
  ledger.markLanded();

  const expected = { runId: args.runId, attempt: args.attempt, claimedAtIso: nowIso };
  let verify = await escalate(ledger, args.id, () => showIssue(deps, args.id));
  if (!verify || !claimVerified(verify, expected)) {
    throw new PartialTriageError(
      args.id,
      `claim on ${args.id} landed but did not verify on read-back (status/assignee/run id/attempt/claimed-at mismatch)`,
    );
  }

  // Self-heal a missing `triage:claimed` label (e.g. left behind by an
  // older, pre-fix run that ignored this specific set-state failure). Any
  // failure here is guarded by the ledger and will now surface loudly.
  if (!hasClaimedLabel(verify)) {
    const stateRes = await bd(deps, bdSetStateArgs(args.id, "claimed", claimReason(args.runId, args.attempt)));
    ledger.guard(args.id, "bd set-state", stateRes);
    verify = await escalate(ledger, args.id, () => showIssue(deps, args.id));
    if (!verify || !claimVerified(verify, expected) || !hasClaimedLabel(verify)) {
      throw new PartialTriageError(
        args.id,
        `claimed-label read-back for ${args.id} did not verify after set-state`,
      );
    }
  }

  return verify;
}

/**
 * Outcome of `checkShortCircuits`: either a terminal `TriageOutcome` (the
 * caller must return it as-is, no further claim processing), or a signal to
 * proceed with claiming, carrying the transcript excerpt (if any) that was
 * read — exactly once — as part of this check, for the caller to thread
 * into `ClaimedCandidate` so `investigate()` never has to re-read the
 * transcript file itself.
 */
type ShortCircuitResult =
  | { kind: "short-circuit"; outcome: TriageOutcome }
  | { kind: "proceed"; transcriptExcerpt: TranscriptExcerpt | null };

/**
 * Missing/unsafe-transcript / comment-cap short circuits, checked right
 * after claiming. This is the *only* place a recorded transcript is ever
 * opened and read: `deps.readTranscriptIfUsable` combines the trust-root
 * check, the regular-file check (via the opened handle's fstat), and the
 * bounded read into one operation, so there is no separate "is this path
 * safe" check followed by a later, independent open elsewhere for a
 * replaced/unsafe file to race against. If the transcript is unusable for
 * any reason, this transitions the ticket straight to
 * `triage-missing`/released, without ever invoking the model.
 */
async function checkShortCircuits(
  deps: TriageRuntimeDeps,
  issue: BdIssue,
  runId: string,
  attempt: number,
  ledger: MutationLedger,
): Promise<ShortCircuitResult> {
  const transcriptPath = getTranscriptPath(issue);
  let transcriptExcerpt: TranscriptExcerpt | null = null;
  if (transcriptPath !== null) {
    const raw = await escalate(ledger, issue.id, () =>
      deps.readTranscriptIfUsable(transcriptPath, deps.config.transcriptReadCapBytes),
    );
    if (raw === null) {
      await postAutomatedComment(
        deps,
        issue.id,
        runId,
        attempt,
        buildTranscriptMissingNote(transcriptPath),
        ledger,
      );
      const stateRes = await bd(
        deps,
        bdSetStateArgs(issue.id, "transcript-missing", transcriptMissingReason(runId, transcriptPath)),
      );
      ledger.guard(issue.id, "bd set-state", stateRes);
      const releaseRes = await bd(deps, bdReleaseArgs(issue.id));
      ledger.guard(issue.id, "bd update", releaseRes);
      await commitStateChange(deps, issue.id, `triage: transcript-missing ${issue.id}`);
      return { kind: "short-circuit", outcome: { kind: "transcript-missing", id: issue.id } };
    }
    transcriptExcerpt = excerptTranscript(raw, {
      headLines: deps.config.transcriptHeadLines,
      tailLines: deps.config.transcriptTailLines,
      maxChars: deps.config.transcriptMaxChars,
    });
  }

  const comments = await escalate(ledger, issue.id, () => listComments(deps, issue.id));
  if (isAutomatedCommentCapReached(comments, deps.config.maxAutomatedComments)) {
    const cause = "automated comment cap already reached for this report";
    const stateRes = await bd(deps, bdSetStateArgs(issue.id, "blocked", blockedReason(runId, attempt, cause)));
    ledger.guard(issue.id, "bd set-state", stateRes);
    const releaseRes = await bd(deps, bdReleaseArgs(issue.id));
    ledger.guard(issue.id, "bd update", releaseRes);
    await commitStateChange(deps, issue.id, `triage: blocked ${issue.id}`);
    return { kind: "short-circuit", outcome: { kind: "blocked", id: issue.id, reason: "automated-comment-cap" } };
  }

  return { kind: "proceed", transcriptExcerpt };
}

async function claimFreshCandidate(deps: TriageRuntimeDeps, candidate: BdIssue): Promise<TriageOutcome> {
  const runId = deps.newRunId();
  const ledger = new MutationLedger();
  const verify = await establishClaim(deps, { id: candidate.id, runId, attempt: 1, isFresh: true }, ledger);
  if (!verify) return { kind: "no-candidate" };

  const shortCircuit = await checkShortCircuits(deps, verify, runId, 1, ledger);
  if (shortCircuit.kind === "short-circuit") return shortCircuit.outcome;

  await commitStateChange(deps, candidate.id, `triage: claim ${candidate.id}`);
  return {
    kind: "claimed",
    id: candidate.id,
    runId,
    attempt: 1,
    issue: verify,
    transcriptExcerpt: shortCircuit.transcriptExcerpt,
  };
}

async function recoverStaleClaim(deps: TriageRuntimeDeps, issue: BdIssue): Promise<TriageOutcome> {
  const runId = getTriageRunId(issue) ?? deps.newRunId();
  const attempt = getTriageAttempt(issue) + 1;
  // `issue` is itself an already-claimed (though stale), already-committed
  // ticket from an earlier pass — a real mutation has already durably
  // landed before this function ever runs — so this ledger starts landed:
  // any read failure below (e.g. the automated-comment-cap check's `bd
  // comments` call, which runs before this function's own first write) must
  // escalate to `PartialTriageError` too, not surface as a plain `Error`.
  const ledger = preLandedLedger();

  if (attempt > deps.config.maxAttempts || hasExceededMaxAttempts(issue, deps.config.maxAttempts)) {
    const cause = "stale claim exceeded the maximum retry count";
    await postAutomatedComment(
      deps,
      issue.id,
      runId,
      getTriageAttempt(issue),
      buildBlockedNote(runId, getTriageAttempt(issue), cause),
      ledger,
    );
    const stateRes = await bd(
      deps,
      bdSetStateArgs(issue.id, "blocked", blockedReason(runId, getTriageAttempt(issue), cause)),
    );
    ledger.guard(issue.id, "bd set-state", stateRes);
    const releaseRes = await bd(deps, bdReleaseArgs(issue.id));
    ledger.guard(issue.id, "bd update", releaseRes);
    await commitStateChange(deps, issue.id, `triage: blocked ${issue.id}`);
    return { kind: "blocked", id: issue.id, reason: "max-attempts" };
  }

  const verify = await establishClaim(deps, { id: issue.id, runId, attempt, isFresh: false }, ledger);
  if (!verify) return { kind: "no-candidate" };

  const shortCircuit = await checkShortCircuits(deps, verify, runId, attempt, ledger);
  if (shortCircuit.kind === "short-circuit") return shortCircuit.outcome;

  await commitStateChange(deps, issue.id, `triage: retry-claim ${issue.id}`);
  return {
    kind: "claimed",
    id: issue.id,
    runId,
    attempt,
    issue: verify,
    transcriptExcerpt: shortCircuit.transcriptExcerpt,
  };
}

// ─── Investigation (outside the lock) ──────────────────────────────────────

async function investigate(
  deps: TriageRuntimeDeps,
  claimed: ClaimedCandidate,
): Promise<InvestigatorResult> {
  // The transcript is never re-read here: `claimed.transcriptExcerpt` was
  // already read exactly once, at claim time, inside the tracker lock (see
  // `checkShortCircuits`). Re-opening the same path here — potentially
  // minutes later, well outside the lock — would reintroduce the exact
  // validate-then-open gap a replaced/unsafe transcript could race through;
  // reusing the already-read content instead makes that structurally
  // impossible, since there is no second file access to race against.
  const transcriptPath = getTranscriptPath(claimed.issue);

  // The claim behind `claimed` already landed and was committed before this
  // function ever runs, so a failure reading its comments here — needed
  // only to build the investigation prompt — is itself a partial/uncertain
  // state a human needs to know about, never a plain, silently-absorbable
  // `Error`.
  let comments: BdComment[];
  try {
    comments = await listComments(deps, claimed.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PartialTriageError(claimed.id, `bd comments read failed while preparing investigation: ${message}`);
  }

  const { facts, investigatorCwd } = await escalate(preLandedLedger(), claimed.id, () =>
    gatherRepoContext(deps, claimed.issue),
  );

  const prompt = buildInvestigationPrompt({
    issue: claimed.issue,
    comments,
    transcriptPath,
    transcriptExcerpt: claimed.transcriptExcerpt,
    repoFacts: facts,
    maxChars: deps.config.maxPromptChars,
  });

  return deps.investigate(prompt, {
    cwd: investigatorCwd,
    timeoutMs: deps.config.investigatorTimeoutMs,
    model: deps.config.model,
    runId: claimed.runId,
    attempt: claimed.attempt,
  });
}

// ─── Finalization ───────────────────────────────────────────────────────────

async function finalizeSuccess(
  deps: TriageRuntimeDeps,
  claimed: ClaimedCandidate,
  findingsText: string,
  audit: InvestigatorAudit | undefined,
): Promise<TriageOutcome> {
  // `claimed` already carries a durably-landed, committed claim; any read
  // failure below (e.g. the `bd comments` read inside `postAutomatedComment`
  // used for crash-safe dedup) must escalate to `PartialTriageError` too.
  const ledger = preLandedLedger();
  // This function is only ever reached for genuinely non-blank findings text
  // (see `runTriageOnce`'s dispatch to `finalizeEmpty` instead when blank);
  // there is deliberately no backwards placeholder-as-success fallback here
  // any more.
  const body = [findingsText.trim(), "", formatAuditBlock(audit ?? null)].join("\n");
  await postAutomatedComment(deps, claimed.id, claimed.runId, claimed.attempt, body, ledger);

  const stateRes = await bd(deps, bdSetStateArgs(claimed.id, "needs-review", needsReviewReason(claimed.runId)));
  ledger.guard(claimed.id, "bd set-state", stateRes);
  const releaseRes = await bd(deps, bdReleaseArgs(claimed.id));
  ledger.guard(claimed.id, "bd update", releaseRes);

  await commitStateChange(deps, claimed.id, `triage: findings ${claimed.id}`);
  return { kind: "completed", id: claimed.id };
}

/**
 * Distinct finalization path for empty/whitespace-only investigator text
 * (see `isBlankInvestigatorText` and `TriageOutcome`'s `finalized-empty`).
 * Deliberately never treated as `completed`: a diagnostic audit comment is
 * posted instead of findings, the ticket goes to `triage:needs-review` (for
 * human attention) and is released to `open`, and — unlike `finalizeFailure`
 * — this never retries automatically regardless of attempt count, since the
 * investigator did not report an execution error.
 */
async function finalizeEmpty(
  deps: TriageRuntimeDeps,
  claimed: ClaimedCandidate,
  audit: InvestigatorAudit | undefined,
): Promise<TriageOutcome> {
  const ledger = preLandedLedger();
  const note = buildEmptyFindingsNote(claimed.runId, claimed.attempt, audit ?? null);
  await postAutomatedComment(deps, claimed.id, claimed.runId, claimed.attempt, note, ledger);

  const stateRes = await bd(
    deps,
    bdSetStateArgs(claimed.id, "needs-review", emptyFindingsReason(claimed.runId)),
  );
  ledger.guard(claimed.id, "bd set-state", stateRes);
  const releaseRes = await bd(deps, bdReleaseArgs(claimed.id));
  ledger.guard(claimed.id, "bd update", releaseRes);

  await commitStateChange(deps, claimed.id, `triage: empty-findings ${claimed.id}`);
  return { kind: "finalized-empty", id: claimed.id };
}

async function finalizeFailure(
  deps: TriageRuntimeDeps,
  claimed: ClaimedCandidate,
  errorMessage: string,
  audit: InvestigatorAudit | undefined,
): Promise<TriageOutcome> {
  if (claimed.attempt >= deps.config.maxAttempts) {
    // Same reasoning as `finalizeSuccess`: `claimed` already carries a
    // durably-landed, committed claim.
    const ledger = preLandedLedger();
    const cause = `investigator failed: ${errorMessage}`;
    await postAutomatedComment(
      deps,
      claimed.id,
      claimed.runId,
      claimed.attempt,
      buildBlockedNote(claimed.runId, claimed.attempt, cause, audit ?? null),
      ledger,
    );
    const stateRes = await bd(
      deps,
      bdSetStateArgs(claimed.id, "blocked", blockedReason(claimed.runId, claimed.attempt, cause)),
    );
    ledger.guard(claimed.id, "bd set-state", stateRes);
    const releaseRes = await bd(deps, bdReleaseArgs(claimed.id));
    ledger.guard(claimed.id, "bd update", releaseRes);
    await commitStateChange(deps, claimed.id, `triage: blocked ${claimed.id}`);
    return { kind: "blocked", id: claimed.id, reason: "investigator-failed" };
  }

  deps.notify(
    `/triage-report: investigation attempt ${claimed.attempt} failed for ${claimed.id}: ${errorMessage}. Leaving it claimed for a later retry.`,
    "warning",
  );
  return { kind: "failed-attempt", id: claimed.id, attempt: claimed.attempt };
}

// ─── Top-level orchestration ────────────────────────────────────────────────

export async function runTriageOnce(deps: TriageRuntimeDeps): Promise<TriageOutcome> {
  if (await deps.isPaused()) return { kind: "paused" };

  let lockTimedOut = false;
  const claimOutcome = await withTrackerLock(deps.trackerDir, async () => {
    if (await isTrackerDirty(deps)) return { kind: "dirty", phase: "pre-claim" } as const;

    const ownClaims = await listOwnActiveClaims(deps);
    const stale = ownClaims.find((issue) => isClaimStale(issue, deps.now(), deps.config.leaseMs));
    if (stale) return recoverStaleClaim(deps, stale);

    // Any active (non-stale) pi-triage claim means an investigation is
    // already in flight, or has not yet been finalized. Only one
    // investigation may run at a time: this is a deliberate no-op even if a
    // different eligible ticket exists, and the model is never invoked.
    if (ownClaims.length > 0) {
      // `bd list` itself (a read-only query) has been observed to trigger
      // the same benign empty-export deletion quirk as `bd export` on a
      // still-empty tracker (see restoreBenignEmptyExportDeletion). Heal
      // again here, since this exit path never runs commitStateChange
      // (which would otherwise re-export/re-commit and mask it).
      await restoreBenignEmptyExportDeletion(deps.exec, deps.trackerDir, GIT_TIMEOUT_MS).catch(() => false);
      return { kind: "claim-in-progress", id: ownClaims[0]!.id } as const;
    }

    const candidates = await listCandidates(deps);
    const candidate = selectCandidate(candidates);
    if (!candidate) {
      // Same reasoning as above: the preceding `bd list` calls may have
      // reintroduced the benign deletion quirk after the earlier dirty
      // check already ran, and no-candidate never reaches commitStateChange
      // to naturally re-export/re-commit.
      await restoreBenignEmptyExportDeletion(deps.exec, deps.trackerDir, GIT_TIMEOUT_MS).catch(() => false);
      return { kind: "no-candidate" } as const;
    }

    return claimFreshCandidate(deps, candidate);
  }).catch((error) => {
    if (error instanceof Error && /Timed out waiting for another report operation/.test(error.message)) {
      lockTimedOut = true;
      return { kind: "lock-timeout", detail: error.message } as const;
    }
    throw error;
  });

  if (lockTimedOut || claimOutcome.kind !== "claimed") return claimOutcome;

  const claimed: ClaimedCandidate = {
    id: claimOutcome.id,
    runId: claimOutcome.runId,
    attempt: claimOutcome.attempt,
    issue: claimOutcome.issue,
    transcriptExcerpt: claimOutcome.transcriptExcerpt,
  };

  deps.notify(
    `${claimed.id}: claim committed; automated investigation attempt ${claimed.attempt} is running and may take several minutes.`,
    "info",
  );

  const investigation = await escalate(preLandedLedger(), claimed.id, () => investigate(deps, claimed));

  return withTrackerLock(deps.trackerDir, async () => {
    if (await escalate(preLandedLedger(), claimed.id, () => isTrackerDirty(deps))) {
      deps.notify(
        `/triage-report: tracker became dirty before finalizing ${claimed.id}; leaving the claim in place for the next stale-recovery pass.`,
        "warning",
      );
      return { kind: "deferred", id: claimed.id, reason: "tracker-dirty" } as const;
    }

    // Re-verify ownership before touching the ticket again. The
    // investigator ran unlocked and can take minutes; during that window a
    // stale-recovery pass (or a human) may have taken the claim over. If
    // ownership changed, never append a comment, set state, or release: that
    // would overwrite whatever the current owner is doing.
    //
    // The claim behind `claimed` already landed and was committed earlier,
    // so a failed or missing read here is not the same thing as a
    // legitimate ownership change: it is a partial/uncertain state that must
    // surface as `PartialTriageError`, never be downgraded to the
    // (silently non-mutating, but misleadingly "nothing to worry about")
    // `ownership-lost` outcome.
    let current: BdIssue;
    try {
      const found = await showIssue(deps, claimed.id);
      if (!found) throw new Error(`bd show returned no result for ${claimed.id}`);
      current = found;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PartialTriageError(claimed.id, `pre-finalization read-back for ${claimed.id} failed: ${message}`);
    }
    if (!stillOwnsClaim(current, claimed.issue)) {
      deps.notify(
        `/triage-report: ownership of ${claimed.id} changed before finalization (status/assignee/claimed-label/run/attempt/claimed-at no longer match); leaving its current state untouched.`,
        "warning",
      );
      return { kind: "ownership-lost", id: claimed.id } as const;
    }

    // Empty or Unicode-whitespace-only investigator text is never treated
    // as success, even when the process exited 0 and reported no execution
    // error: it is dispatched to the distinct `finalizeEmpty` path (no
    // automatic retry) rather than `finalizeSuccess`'s backwards
    // placeholder-as-success behavior, which no longer exists.
    if (investigation.ok) {
      if (isBlankInvestigatorText(investigation.text)) {
        return finalizeEmpty(deps, claimed, investigation.audit);
      }
      return finalizeSuccess(deps, claimed, investigation.text, investigation.audit);
    }
    return finalizeFailure(
      deps,
      claimed,
      investigation.error ?? "investigator returned no result",
      investigation.audit,
    );
  });
}

// ─── Real dependency wiring (used by index.ts) ─────────────────────────────

/** Where automated (non-diagnostic) audit excerpts of the raw investigator stdout are capped, in characters. */
const INVESTIGATOR_AUDIT_EXCERPT_CHARS = 2_000;

/**
 * Resolves the actual persisted session file for `sessionId` under
 * `sessionsDir`, by suffix-matching Pi's own
 * `<ISO-8601-with-hyphens>_<sessionId>.jsonl` filename convention (see Pi's
 * session manager). Returns `null` on any failure (missing directory, no
 * match) rather than throwing — this is best-effort audit enrichment, never
 * a correctness dependency: the session id itself (which this process
 * chose and passed via `--session-id`) is always known and recorded
 * regardless of whether the file can be located afterward.
 */
async function resolveInvestigatorSessionFile(sessionsDir: string, sessionId: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return null;
  }
  const suffix = `_${sessionId}.jsonl`;
  const matches = entries.filter((name) => name.endsWith(suffix)).sort();
  const last = matches[matches.length - 1];
  return last ? join(sessionsDir, last) : null;
}

/** Bound on how many bytes of a discovered session file are ever read to verify its header id (see `verifySessionFileAttribution`). The header is always the very first line, so this is intentionally generous relative to a single JSON line while still never loading an arbitrarily large file in full, and while never reading anything past the head (see `readHeadOnly`). */
const SESSION_HEADER_READ_CAP_BYTES = 65_536;

/**
 * Bounded, head-only read of a file by path: opens it and reads at most
 * `maxBytes` from the very start, regardless of the file's total size —
 * unlike `readBoundedTranscript`, which also reads a tail chunk for large
 * files. A Pi session header is always the file's first line by
 * construction (see `parseSessionHeaderLine`'s doc), and verifying it never
 * needs anything past a small head read; reading *only* the head, never the
 * tail, is what makes it structurally impossible for a "session"-shaped
 * object appearing later in the file (in a legitimate later turn, a
 * truncated/corrupted file, or a deliberately crafted one) to ever be
 * combined with the real first line and mistaken for the header.
 */
async function readHeadOnly(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const bytesToRead = Math.max(0, Math.min(maxBytes, size));
    const buf = Buffer.alloc(bytesToRead);
    if (bytesToRead > 0) await handle.read(buf, 0, bytesToRead, 0);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Strengthens `resolveInvestigatorSessionFile`'s filename-suffix match with
 * an actual content check: opens the discovered file with a bounded,
 * head-only read and requires *only its first line* to parse as a Pi
 * session header whose `id` equals `sessionId` — the exact id this call
 * explicitly requested via `--session-id`. Suffix-matching alone trusts
 * only the *filename*; the dedicated investigator-sessions directory can
 * accumulate a stale file left behind by an earlier crashed attempt (or, in
 * the worst case, an unrelated file that merely happens to share the same
 * filename suffix), and blindly attributing such a file to *this* attempt
 * would publish a wrong or stale `sessionFile` path into the tracker-facing
 * audit trail — exactly the kind of unverifiable audit data this whole
 * mechanism exists to prevent.
 *
 * Deliberately uses `parseSessionHeaderLine` (first-line-only) rather than
 * `parseInvestigatorJsonl` (which scans every line for the first
 * session-shaped record): a bad/non-session first line followed by a
 * "session"-shaped object on some later line in the file must fail this
 * check, not be accepted just because *some* line eventually matched.
 * Returns `true` only when the file's first line is a well-formed session
 * header whose id matches; `false` for a mismatch, an unreadable file, or a
 * first line that isn't a parseable session header at all.
 */
async function verifySessionFileAttribution(sessionFile: string, sessionId: string): Promise<boolean> {
  let content: string;
  try {
    content = await readHeadOnly(sessionFile, SESSION_HEADER_READ_CAP_BYTES);
  } catch {
    return false;
  }
  const header = parseSessionHeaderLine(content);
  return header !== null && header.id === sessionId;
}

/**
 * Deletes investigator session files beyond the newest `keep` under
 * `sessionsDir` (see `selectInvestigatorSessionFilesForPruning` for the pure
 * selection logic). Best-effort and narrowly scoped: only files directly
 * inside `sessionsDir` ending in `.jsonl` are ever considered, and a missing
 * directory or an individual failed delete never throws — retention is a
 * housekeeping concern, never allowed to fail an investigator run.
 */
export async function pruneInvestigatorSessions(sessionsDir: string, keep: number): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const jsonlFiles = entries.filter((name) => name.endsWith(".jsonl"));
  const toRemove = selectInvestigatorSessionFilesForPruning(jsonlFiles, keep);
  for (const name of toRemove) {
    await rm(join(sessionsDir, name), { force: true }).catch(() => {});
  }
  return toRemove;
}

/**
 * Real inner-investigator wiring: a fresh `pi --mode json` subprocess given
 * no tools, no extensions, and no network, writing into a persistent,
 * dedicated, private session directory (`sessionsDir`) under an explicit,
 * safe session id correlated to this run/attempt (see
 * `buildInvestigatorSessionId`) rather than the previous `--no-session`
 * (ephemeral, untraceable) invocation. `--mode json` is used instead of
 * plain `-p` text output specifically so this code can independently
 * classify the terminal assistant message's `stopReason`/`errorMessage` —
 * a request that failed or was aborted server-side can still make the `pi`
 * process itself exit 0 (see `parseInvestigatorJsonl`), so relying on the
 * subprocess exit code alone would misclassify that as success.
 *
 * Session retention (`sessionRetention`, newest-N kept) is pruned
 * best-effort after every call so this directory never grows unbounded;
 * pruning failures are swallowed and never fail the investigator call.
 */
export function makeRealInvestigator(
  execFn: ExecFn,
  piExecutable = "pi",
  sessionsDir: string,
  sessionRetention = 200,
): InvestigatorFn {
  return async (prompt, opts) => {
    const sessionId = buildInvestigatorSessionId(opts.runId, opts.attempt);
    const args = [
      "--mode",
      "json",
      "--session-dir",
      sessionsDir,
      "--session-id",
      sessionId,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--offline",
      "--no-tools",
      ...(opts.model ? ["--model", opts.model] : []),
      prompt,
    ];

    await mkdir(sessionsDir, { recursive: true }).catch(() => {});
    const res = await execFn(piExecutable, args, { cwd: opts.cwd, timeout: opts.timeoutMs });

    const parsed = parseInvestigatorJsonl(res.stdout);
    const sessionFile = await resolveInvestigatorSessionFile(sessionsDir, sessionId);
    // Strengthen the filename-suffix match above with an actual content
    // check before this call ever attributes `sessionFile` to this attempt
    // as trustworthy audit data: a discovered file's own first line must
    // self-identify, as a Pi session header, with the exact `sessionId`
    // this call requested. See `verifySessionFileAttribution` for why
    // filename matching alone is not sufficient. Deliberately runs *before*
    // pruning, so pruning can never remove the very file this check is
    // about to inspect.
    //
    // `sessionFile === null` (no persisted file could even be discovered)
    // is now *also* treated as unverified, not as a benign "unresolved"
    // edge case: the core auditability goal of this whole mechanism is that
    // every *successful* investigator attempt is persisted, so an exit-0
    // run with nothing discoverable to persist must fail rather than
    // silently succeed with `sessionFile: null` (see the check below).
    const sessionFileVerified =
      sessionFile !== null && (await verifySessionFileAttribution(sessionFile, sessionId));
    await pruneInvestigatorSessions(sessionsDir, sessionRetention).catch(() => []);

    const baseAudit: InvestigatorAudit = {
      sessionId,
      sessionFile,
      stopReason: parsed.finalAssistant?.stopReason ?? null,
      errorMessage: parsed.finalAssistant?.errorMessage ?? null,
      exitCode: res.code,
      killed: Boolean(res.killed),
      // `res.stdout`/`res.stderr` are already Node/pi.exec-decoded strings
      // by this point, not raw OS pipe bytes; these four fields are
      // metadata about that decoded-then-UTF-8-re-encoded representation
      // (see the `InvestigatorAudit` interface doc in triage-core.ts for
      // why that distinction matters and why this is not "redesigned" to
      // operate on raw Buffers).
      stdoutBytes: Buffer.byteLength(res.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(res.stderr, "utf8"),
      stdoutSha256: sha256Hex(res.stdout),
      stderrSha256: sha256Hex(res.stderr),
      stdoutExcerpt: "",
      stderrExcerpt: boundedTextExcerpt(res.stderr, INVESTIGATOR_AUDIT_EXCERPT_CHARS),
      malformedLineCount: parsed.malformedLineCount,
    };

    // The process-level exec failure/kill check runs first and independently
    // of anything JSONL-derived: a non-zero exit or a kill is always an
    // investigator failure regardless of what (if anything) parsed.
    if (res.code !== 0 || res.killed) {
      const detail = commandError("pi --mode json (investigator)", res.code, res.stderr, res.stdout).message;
      return {
        ok: false,
        text: "",
        error: detail,
        audit: { ...baseAudit, errorMessage: baseAudit.errorMessage ?? detail, stdoutExcerpt: boundedTextExcerpt(res.stdout, INVESTIGATOR_AUDIT_EXCERPT_CHARS) },
      };
    }

    // Tightened persistence/attribution contract: an exit-0 result is only
    // ever accepted as success once its persisted session file has been
    // positively discovered *and* attribution-verified. This covers both
    // failure shapes with one check:
    //   - `sessionFile === null`: no persisted file could be discovered at
    //     all for the explicitly requested session id — never accepted as
    //     success just because the model's own stdout output looked fine.
    //   - a discovered `sessionFile` whose own first-line header id does not
    //     match the requested session id — treated exactly like missing/
    //     malformed terminal audit data below.
    // Either way this is independent of (and checked before) the stdout-
    // derived `finalAssistant`/`stopReason` checks: a wrong, missing, or
    // stale session-file attribution is itself the failure, regardless of
    // whether the model's stdout response otherwise looked perfectly fine.
    if (!sessionFileVerified) {
      const detail =
        sessionFile === null
          ? `investigator process exited 0 but no persisted session file could be discovered under ${sessionsDir} for the explicitly requested session id "${sessionId}"`
          : `investigator session file attribution mismatch: discovered ${sessionFile} does not carry a session header matching the explicitly requested session id "${sessionId}"`;
      return {
        ok: false,
        text: "",
        error: detail,
        audit: { ...baseAudit, errorMessage: detail, stdoutExcerpt: boundedTextExcerpt(res.stdout, INVESTIGATOR_AUDIT_EXCERPT_CHARS) },
      };
    }

    // Missing/malformed terminal assistant data (no well-formed assistant
    // `message_end`/`agent_end` ever observed) is an investigator failure
    // even though the process exited 0.
    if (!parsed.finalAssistant) {
      const detail = "investigator process exited 0 but produced no parseable terminal assistant message";
      return {
        ok: false,
        text: "",
        error: detail,
        audit: { ...baseAudit, errorMessage: detail, stdoutExcerpt: boundedTextExcerpt(res.stdout, INVESTIGATOR_AUDIT_EXCERPT_CHARS) },
      };
    }

    // Independently classify a `stopReason` of `error`/`aborted` as an
    // investigator failure, even when the process itself exited 0 — Pi's
    // JSON-mode assistant message can report a server/provider-side failure
    // or an abort without the CLI process exit code reflecting it.
    if (parsed.finalAssistant.stopReason === "error" || parsed.finalAssistant.stopReason === "aborted") {
      const detail =
        parsed.finalAssistant.errorMessage || `investigator request ${parsed.finalAssistant.stopReason}`;
      return {
        ok: false,
        text: parsed.finalAssistant.text,
        error: detail,
        audit: { ...baseAudit, stdoutExcerpt: boundedTextExcerpt(res.stdout, INVESTIGATOR_AUDIT_EXCERPT_CHARS) },
      };
    }

    return { ok: true, text: parsed.finalAssistant.text, audit: baseAudit };
  };
}

/**
 * Head+tail byte budget for a bounded read of a file of `size` bytes capped
 * at `maxBytes` total. Exported (pure, no IO) so the arithmetic itself —
 * including the `maxBytes` edge cases below — can be unit-tested directly
 * without needing a real file.
 *
 * `headBytes + tailBytes` must never exceed `maxBytes`: in particular, for
 * `maxBytes === 1` this must read exactly one byte total (all head, no
 * tail), not two, which an earlier version of this arithmetic got wrong by
 * flooring each half up to a 1-byte minimum independently.
 */
export function boundedReadPlan(size: number, maxBytes: number): { headBytes: number; tailBytes: number } {
  const cap = Math.max(0, Math.min(maxBytes, size));
  const headBytes = Math.max(0, Math.min(cap, Math.ceil(cap / 2)));
  const tailBytes = Math.max(0, cap - headBytes);
  return { headBytes, tailBytes };
}

/**
 * Bounded read from an already-open file handle: reads at most `maxBytes`
 * total bytes, combining a head chunk and a tail chunk for files larger
 * than that rather than ever loading an arbitrarily large (or maliciously
 * huge) file fully into memory. Operating on a handle (rather than a path)
 * lets callers fold this into a single open+fstat+read sequence with their
 * own trust/type checks in between, instead of a separate path-based check
 * followed by an independent later open.
 */
async function readBoundedFromHandle(
  handle: { read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<unknown> },
  size: number,
  maxBytes: number,
): Promise<string> {
  if (size <= maxBytes) {
    const buf = Buffer.alloc(size);
    if (size > 0) await handle.read(buf, 0, size, 0);
    return buf.toString("utf8");
  }
  const { headBytes, tailBytes } = boundedReadPlan(size, maxBytes);
  const headBuf = Buffer.alloc(headBytes);
  if (headBytes > 0) await handle.read(headBuf, 0, headBytes, 0);
  const tailBuf = Buffer.alloc(tailBytes);
  if (tailBytes > 0) await handle.read(tailBuf, 0, tailBytes, size - tailBytes);
  return [
    headBuf.toString("utf8"),
    `\n… (file is ${size} bytes; only the first/last ${maxBytes} bytes were read from disk before excerpting) …\n`,
    tailBuf.toString("utf8"),
  ].join("");
}

/**
 * Bounded read of a transcript file by path: opens it, then delegates to
 * `readBoundedFromHandle`. Kept as a standalone export (used directly by a
 * few tests exercising the byte-cap arithmetic against real files); the
 * production `/triage-report` read path goes through `readTranscriptIfUsable`
 * below instead, which folds the trust/type checks and the read into one
 * operation on one handle.
 */
export async function readBoundedTranscript(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    return await readBoundedFromHandle(handle, size, maxBytes);
  } finally {
    await handle.close();
  }
}

/**
 * Trusted-boundary + regular-file usability check for a transcript path
 * taken from ticket metadata, *without* reading it. That metadata is
 * written by `/report` at report time, but by the time a triage pass runs
 * later it has been sitting in a shared Beads tracker anyone with write
 * access could have edited, so the path is not fully trusted input: resolve
 * symlinks, require the resolved path to be inside `sessionsRoot`, and
 * require it to be a regular, readable file (never a directory, device,
 * FIFO, or socket). Any failure — missing, wrong type, outside the trusted
 * root, unreadable — returns `false` deterministically.
 *
 * This standalone check is kept for direct unit testing of the trust-
 * boundary logic and any other caller that only needs a yes/no answer, but
 * `/triage-report`'s own claim/investigation path never uses it on its own:
 * see `readTranscriptIfUsable`, which performs the equivalent check *and*
 * the actual read against the same opened handle, so there is no window
 * between "checked safe" and "opened for real" for a path to be swapped out
 * from under it.
 */
export async function isTranscriptPathUsable(path: string, sessionsRoot: string): Promise<boolean> {
  try {
    const real = await realpath(path);
    // Resolve the root through symlinks too (e.g. macOS's /tmp -> /private/tmp):
    // comparing a symlink-resolved candidate against an un-resolved root would
    // otherwise reject every legitimate path under a symlinked root. Fall back
    // to the plain resolved root if it doesn't exist yet (realpath would throw).
    const realRoot = await realpath(sessionsRoot).catch(() => sessionsRoot);
    if (!isWithinTrustedRoot(real, realRoot)) return false;
    const info = await stat(real);
    if (!info.isFile()) return false;
    await access(real, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function makeIsTranscriptUsable(sessionsRoot: string): (path: string) => Promise<boolean> {
  return (path: string) => isTranscriptPathUsable(path, sessionsRoot);
}

/**
 * The single, race-closing operation for a recorded transcript path: resolve
 * and check the trusted sessions root, open the resolved path, use the
 * *opened handle's* fstat to confirm it is a regular file, and read at most
 * `maxBytes` bytes from that same handle — never a separate boolean
 * "is this safe" check followed by a later, independent open. Returns `null`
 * for every failure mode alike (missing, wrong type, outside the trusted
 * root, unreadable, read error); callers must treat that identically to "no
 * transcript" and never invoke the model.
 *
 * This still cannot make the initial `realpath`/root-check fully atomic with
 * the subsequent `open` at the OS level (Node's `fs/promises` has no portable
 * "open, then verify the path that was actually opened" primitive without
 * native addons), but opening the *resolved* path directly — rather than the
 * original, possibly-symlinked one — collapses that remaining window to a
 * single final hop, and, critically, this function is only ever called once
 * per claim (at claim time; see `checkShortCircuits`), with its result
 * carried forward rather than re-read later during investigation. That is
 * what actually closes the validate-then-open gap that mattered in practice:
 * there is no second, much-later read for a replacement to race against.
 */
export async function readTranscriptIfUsable(
  path: string,
  sessionsRoot: string,
  maxBytes: number,
): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return null;
  }
  const realRoot = await realpath(sessionsRoot).catch(() => sessionsRoot);
  if (!isWithinTrustedRoot(real, realRoot)) return null;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(real, "r");
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    return await readBoundedFromHandle(handle, info.size, maxBytes);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export function makeReadTranscriptIfUsable(
  sessionsRoot: string,
): (path: string, maxBytes: number) => Promise<string | null> {
  return (path: string, maxBytes: number) => readTranscriptIfUsable(path, sessionsRoot, maxBytes);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function pausedFlagPath(agentDir: string): string {
  return join(agentDir, "pi-report-triage", "paused");
}

/**
 * Persistent, dedicated, private directory for inner-investigator Pi
 * sessions — distinct from a user's own interactive/print-mode session
 * directory, and never shared with it, so investigator sessions are always
 * separately auditable/retainable and never mixed into a human's session
 * history or picker. See `makeRealInvestigator` (uses it via `--session-dir`)
 * and `pruneInvestigatorSessions` (retention).
 */
export function investigatorSessionsDir(agentDir: string): string {
  return join(agentDir, "pi-report-triage", "investigator-sessions");
}

export async function isPausedFlagSet(agentDir: string): Promise<boolean> {
  return pathExists(pausedFlagPath(agentDir));
}

export async function setPausedFlag(agentDir: string, paused: boolean): Promise<void> {
  const path = pausedFlagPath(agentDir);
  if (paused) {
    await mkdir(join(agentDir, "pi-report-triage"), { recursive: true });
    await writeFile(path, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
  } else {
    await rm(path, { force: true });
  }
}
