import { writeSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildIssueDescription,
  commandError,
  countSessionEntries,
  hardenedCommitArgs,
  isDirectory,
  parseCreatedBead,
  parseReportInput,
  restoreBenignEmptyExportDeletion,
  withTrackerLock,
  type GitMetadata,
  type ReportMetadata,
} from "./report-core.ts";
import {
  bdCandidatesArgs,
  formatHeadlessFailureStderrLine,
  generateRunId,
  isBenignTriageOutcome,
  isHeadlessExitOnFailureEnabled,
  loadTriageConfig,
  parseBdJsonArray,
  shouldForceHeadlessExit,
  type BdIssue,
  type TriageOutcome,
} from "./triage-core.ts";
import {
  investigatorSessionsDir,
  isPausedFlagSet,
  makeReadTranscriptIfUsable,
  makeRealInvestigator,
  runTriageOnce,
  setPausedFlag,
  PartialTriageError,
  type ExecFn,
  type TriageRuntimeDeps,
} from "./triage-runtime.ts";

function nonEmptyEnvPath(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

const TRACKER_DIR = nonEmptyEnvPath("PI_REPORT_TRACKER_DIR", join(homedir(), "pi", "reports"));
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const SETUP_SCRIPT = join(EXTENSION_DIR, "setup-tracker.sh");
const EMPTY_HOOKS_DIR = join(TRACKER_DIR, ".git", "pi-report-empty-hooks");
const COMMAND_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 10_000;

class PartialReportError extends Error {
  constructor(
    readonly beadId: string,
    message: string,
  ) {
    super(message);
  }
}

const AGENT_DIR = nonEmptyEnvPath("PI_CODING_AGENT_DIR", join(homedir(), ".pi", "agent"));
// Trusted root for session transcripts referenced by report tickets. Ticket
// metadata is not fully trusted by triage time (it lives in a shared, human-
// editable tracker), so a recorded `transcriptFile` path is only ever read
// after confirming it resolves inside this directory. See
// `isTranscriptPathUsable` in triage-runtime.ts.
const SESSIONS_DIR = nonEmptyEnvPath("PI_TRIAGE_SESSIONS_DIR", join(AGENT_DIR, "sessions"));
// Persistent, dedicated, private session directory for the inner
// investigator process (see `makeRealInvestigator`), distinct from a human's
// own interactive session directory (`SESSIONS_DIR` above, which is also the
// trusted *read* root for recorded report transcripts — an unrelated
// concern). Investigator sessions are retained (newest-N, pruned after every
// run) rather than ephemeral, so a past investigation can always be traced
// back to its exact run/attempt and inspected directly with `pi --session`.
const INVESTIGATOR_SESSIONS_DIR = investigatorSessionsDir(AGENT_DIR);

async function collectGitMetadata(pi: ExtensionAPI, cwd: string): Promise<GitMetadata | null> {
  const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  });
  if (root.code !== 0) return null;

  const [branch, head, status] = await Promise.all([
    pi.exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    }),
    pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS }),
    pi.exec("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    }),
  ]);

  if (head.code !== 0 || status.code !== 0) return null;
  return {
    root: root.stdout.trim(),
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
    head: head.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
  };
}

function collectExtensionSources(pi: ExtensionAPI): string[] {
  const sources = new Set<string>();

  for (const command of pi.getCommands()) {
    if (command.source === "extension" && command.sourceInfo.path) {
      sources.add(command.sourceInfo.path);
    }
  }

  for (const tool of pi.getAllTools()) {
    const source = tool.sourceInfo;
    if (source.source !== "builtin" && source.source !== "sdk" && source.path) {
      sources.add(source.path);
    }
  }

  return [...sources].sort();
}

async function collectMetadata(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<ReportMetadata> {
  const sessionManager = ctx.sessionManager;
  const header = sessionManager.getHeader();
  const allEntries = sessionManager.getEntries();
  const activeBranch = sessionManager.getBranch();
  const transcriptFile = sessionManager.getSessionFile() ?? null;
  const model = ctx.model
    ? { provider: ctx.model.provider, id: ctx.model.id }
    : null;

  const reportTimestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    source: "pi-report",
    reportKey: `${sessionManager.getSessionId()}:${reportTimestamp}`,
    reportTimestamp,
    session: {
      id: sessionManager.getSessionId(),
      name: sessionManager.getSessionName() ?? null,
      startedAt: header?.timestamp ?? null,
      cwd: sessionManager.getCwd(),
      transcriptFile,
      persisted: transcriptFile !== null,
      leafId: sessionManager.getLeafId(),
      parentSession: header?.parentSession ?? null,
      counts: countSessionEntries(allEntries, activeBranch),
    },
    runtime: {
      piVersion: VERSION,
      nodeVersion: process.version,
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      model,
      thinkingLevel: pi.getThinkingLevel(),
      activeTools: [...pi.getActiveTools()].sort(),
      extensionSources: collectExtensionSources(pi),
    },
    git: await collectGitMetadata(pi, ctx.cwd),
  };
}

async function validateTracker(pi: ExtensionAPI): Promise<string | null> {
  const bd = await pi.exec("bd", ["--version"], { timeout: GIT_TIMEOUT_MS });
  if (bd.code !== 0) {
    return `The bd executable is unavailable. Install Beads, then run:\n${SETUP_SCRIPT}`;
  }

  const [hasGit, hasBeads] = await Promise.all([
    isDirectory(join(TRACKER_DIR, ".git")),
    isDirectory(join(TRACKER_DIR, ".beads")),
  ]);
  if (!hasGit || !hasBeads) {
    return `The Pi reports tracker is not initialized at ${TRACKER_DIR}. Run:\n${SETUP_SCRIPT}`;
  }

  return null;
}

async function assertTrackerExportIsClean(pi: ExtensionAPI): Promise<void> {
  const clean = await restoreBenignEmptyExportDeletion(
    (command, args, options) => pi.exec(command, args, options),
    TRACKER_DIR,
    GIT_TIMEOUT_MS,
  );
  if (clean) return;

  throw new Error(
    `Tracker export has uncommitted changes; recover or commit ${join(TRACKER_DIR, ".beads", "issues.jsonl")} before creating another report`,
  );
}

async function findBeadByReportKey(
  pi: ExtensionAPI,
  reportKey: string,
): Promise<{ id: string } | null> {
  const listed = await pi.exec(
    "bd",
    ["list", "--all", "--metadata-field", `reportKey=${reportKey}`, "--json"],
    { cwd: TRACKER_DIR, timeout: COMMAND_TIMEOUT_MS },
  );
  if (listed.code !== 0) return null;

  try {
    const values = JSON.parse(listed.stdout) as Array<{ id?: unknown; metadata?: unknown }>;
    const matches = values.filter((value) => typeof value?.id === "string");
    return matches.length === 1 ? { id: matches[0].id as string } : null;
  } catch {
    return null;
  }
}

async function resetStagedExport(pi: ExtensionAPI): Promise<void> {
  await pi.exec("git", ["reset", "--", ".beads/issues.jsonl"], {
    cwd: TRACKER_DIR,
    timeout: GIT_TIMEOUT_MS,
  });
}

async function createBead(
  pi: ExtensionAPI,
  title: string,
  description: string,
  metadata: ReportMetadata,
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-report-"));
  const bodyFile = join(tempDir, "body.md");

  try {
    await writeFile(bodyFile, description, { encoding: "utf8", mode: 0o600 });
    const create = await pi.exec(
      "bd",
      [
        "create",
        "--title",
        title,
        "--type",
        "bug",
        "--priority",
        "P2",
        "--labels",
        "pi-report",
        "--body-file",
        bodyFile,
        "--metadata",
        JSON.stringify(metadata),
        "--json",
      ],
      { cwd: TRACKER_DIR, timeout: COMMAND_TIMEOUT_MS },
    );
    if (create.code !== 0) {
      throw commandError("bd create", create.code, create.stderr, create.stdout);
    }

    let bead: { id: string };
    try {
      bead = parseCreatedBead(create.stdout);
    } catch (parseError) {
      const recovered = await findBeadByReportKey(pi, metadata.reportKey);
      if (!recovered) {
        throw new PartialReportError(
          `unknown (report key ${metadata.reportKey})`,
          parseError instanceof Error ? parseError.message : String(parseError),
        );
      }
      bead = recovered;
    }

    const exported = await pi.exec(
      "bd",
      ["export", "--no-memories", "--output", ".beads/issues.jsonl"],
      { cwd: TRACKER_DIR, timeout: COMMAND_TIMEOUT_MS },
    );
    if (exported.code !== 0) {
      throw new PartialReportError(
        bead.id,
        commandError("bd export", exported.code, exported.stderr, exported.stdout).message,
      );
    }

    const staged = await pi.exec("git", ["add", "-f", ".beads/issues.jsonl"], {
      cwd: TRACKER_DIR,
      timeout: GIT_TIMEOUT_MS,
    });
    if (staged.code !== 0) {
      throw new PartialReportError(
        bead.id,
        commandError("git add", staged.code, staged.stderr, staged.stdout).message,
      );
    }

    await mkdir(EMPTY_HOOKS_DIR, { recursive: true });
    const committed = await pi.exec(
      "git",
      hardenedCommitArgs(EMPTY_HOOKS_DIR, bead.id),
      { cwd: TRACKER_DIR, timeout: COMMAND_TIMEOUT_MS },
    );
    if (committed.code !== 0) {
      await resetStagedExport(pi);
      throw new PartialReportError(
        bead.id,
        commandError("git commit", committed.code, committed.stderr, committed.stdout).message,
      );
    }

    return bead.id;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export default function reportExtension(pi: ExtensionAPI) {
  pi.registerCommand("report", {
    description: "Create a deterministic Beads report for the current Pi session",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify("/report is available only in Pi's interactive TUI", "error");
        }
        return;
      }

      const trackerError = await validateTracker(pi);
      if (trackerError) {
        ctx.ui.notify(trackerError, "error");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify("Waiting for the current agent run to finish before reporting…", "info");
      }
      await ctx.waitForIdle();

      const entered = await ctx.ui.editor(
        "Report issue (first non-empty line is the title)",
        args.trim(),
      );
      if (entered === undefined) {
        ctx.ui.notify("Report cancelled", "info");
        return;
      }

      const input = parseReportInput(entered);
      if (!input) {
        ctx.ui.notify("Report cancelled: a non-empty title is required", "warning");
        return;
      }

      try {
        const metadata = await collectMetadata(pi, ctx);
        const description = buildIssueDescription(input, metadata);
        const beadId = await withTrackerLock(TRACKER_DIR, async () => {
          await assertTrackerExportIsClean(pi);
          return createBead(pi, input.title, description, metadata);
        });
        ctx.ui.notify(
          `Created ${beadId}: ${input.title}\nTracker: ${TRACKER_DIR}\nTranscript: ${metadata.session.transcriptFile ?? "not persisted"}`,
          "info",
        );
      } catch (error) {
        if (error instanceof PartialReportError) {
          ctx.ui.notify(
            [
              `Created ${error.beadId}, but export or Git commit failed.`,
              error.message,
              "Deterministic recovery:",
              `cd ${TRACKER_DIR}`,
              "bd export --no-memories --output .beads/issues.jsonl",
              "git add -f .beads/issues.jsonl",
              `git -c core.hooksPath=${EMPTY_HOOKS_DIR} commit --no-verify -m \"report: ${error.beadId}\" -- .beads/issues.jsonl`,
            ].join("\n"),
            "error",
          );
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Report failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("triage-report", {
    description:
      "Run one automated triage pass over open pi-report tickets, or manage pause/resume/status",
    getArgumentCompletions: (prefix) => {
      const subcommands = ["run", "pause", "resume", "status"];
      const filtered = subcommands.filter((s) => s.startsWith(prefix.trim()));
      return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const notify = (message: string, level: "info" | "warning" | "error") => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, level);
        } else {
          console.log(`[triage-report:${level}] ${message}`);
        }
      };

      const sub = args.trim().toLowerCase();

      if (sub === "pause") {
        await setPausedFlag(AGENT_DIR, true);
        notify(
          "/triage-report paused. It will not select, claim, or investigate reports until resumed. Existing claims are left untouched.",
          "info",
        );
        return;
      }
      if (sub === "resume") {
        await setPausedFlag(AGENT_DIR, false);
        notify("/triage-report resumed.", "info");
        return;
      }
      if (sub !== "" && sub !== "run" && sub !== "status") {
        const message = `Unknown /triage-report subcommand: "${sub}". Use pause, resume, status, or no argument to run one pass.`;
        notify(message, "warning");
        // An unrecognized subcommand is a non-benign outcome for the
        // headless failure-visibility policy: a scheduled pi-tick job
        // misconfigured with a typo'd subcommand (e.g. "rnu" instead of
        // "run") must be visibly detectable via a nonzero exit, not just a
        // warning nobody reads. No tracker mutation or UI status was ever
        // touched on this path, so finalization/cleanup are trivially
        // already "done" here too.
        maybeForceHeadlessExit(ctx.mode, false, message);
        return;
      }

      const trackerError = await validateTracker(pi);
      if (trackerError) {
        notify(trackerError, "error");
        // No tracker mutation and no UI status was ever set on this path, so
        // finalization/cleanup are trivially already "done" — safe to apply
        // the headless failure policy immediately.
        maybeForceHeadlessExit(ctx.mode, false, trackerError);
        return;
      }

      if (sub === "status") {
        notify(await describeTriageStatus(pi), "info");
        // `status` is a read-only diagnostic, not the scheduled "run one pass"
        // contract pi-tick invokes (see README); it is intentionally outside
        // this failure policy.
        return;
      }

      notify(
        "/triage-report started: checking for one eligible report. If a report is claimed, automated investigation can take several minutes; a completion notice will follow.",
        "info",
      );
      if (ctx.hasUI) {
        ctx.ui.setStatus("triage-report", "triage: running…");
      }

      // Tracked across the try/catch/finally below so the headless-exit
      // decision can be made exactly once, after finalization (any tracker
      // mutation/commit performed by `runTriageOnce`) and UI cleanup (the
      // `finally` block's `setStatus` reset) have both already happened —
      // never before either.
      let outcomeIsBenign = false;
      let failureDetailForStderr = "triage run did not complete successfully";

      const deps = buildTriageDeps(pi, notify);
      try {
        const outcome = await runTriageOnce(deps);
        const described = describeTriageOutcome(outcome);
        notify(described.message, described.level);
        outcomeIsBenign = isBenignTriageOutcome(outcome);
        failureDetailForStderr = described.message;
      } catch (error) {
        outcomeIsBenign = false;
        if (error instanceof PartialTriageError) {
          const partialMessage = [
            `A Beads mutation for ${error.id} already landed, but a later step in the same /triage-report operation then failed.`,
            "That later step can be another Beads write (a set-state/update/comment call), a Beads *read* used to verify a claim or gather comments, or the Git export/add/commit that mirrors Beads state into the tracker's Git history — any of them can leave this in a partial state once an earlier step has already landed.",
            error.message,
            "Deterministic recovery: inspect the ticket first, then explicitly re-sync its current Beads state into Git. Commit only when the export actually differs:",
            `cd ${TRACKER_DIR}`,
            `bd show ${error.id} --json`,
            "bd export --no-memories --output .beads/issues.jsonl",
            "git add -f .beads/issues.jsonl",
            `if ! git diff --cached --quiet -- .beads/issues.jsonl; then git -c core.hooksPath=${EMPTY_HOOKS_DIR} commit --no-verify -m "triage: recover ${error.id}" -- .beads/issues.jsonl; fi`,
            `Confirm the ticket's claim, labels, and comments match what you expect before relying on further automated /triage-report passes. The tracker may already be Git-clean when the failure was a read after a previously committed claim.`,
          ].join("\n");
          notify(partialMessage, "error");
          failureDetailForStderr = `partial mutation for ${error.id}: ${error.message}`;
        } else {
          const message = error instanceof Error ? error.message : String(error);
          notify(`Triage run failed: ${message}`, "error");
          failureDetailForStderr = message;
        }
      } finally {
        if (ctx.hasUI) {
          ctx.ui.setStatus("triage-report", undefined);
        }
      }

      // Only reached after the finally block above has already run, i.e.
      // strictly after every required tracker mutation/commit inside
      // `runTriageOnce` (or its thrown `PartialTriageError`) and the UI
      // status cleanup are both complete.
      maybeForceHeadlessExit(ctx.mode, outcomeIsBenign, failureDetailForStderr);
    },
  });
}

/**
 * Applies the headless/scheduled failure-visibility policy (see
 * `shouldForceHeadlessExit` in triage-core.ts): outside an interactive TUI
 * session, a non-benign `/triage-report` outcome writes one synchronous,
 * bounded `Error:` line to stderr and then calls `process.exit(1)` directly
 * — bypassing Pi 0.84.1's RPC-mode shutdown path, which hardcodes exit 0
 * regardless of what happened, and print mode's own exit code, which never
 * reflects an extension command's outcome at all. `fs.writeSync` (not
 * `process.stderr.write`) is used deliberately so the write is guaranteed to
 * complete synchronously before `process.exit(1)` runs, on every platform,
 * with no risk of a buffered/async write being dropped by the immediate
 * process termination that follows. Never called before finalization/UI
 * cleanup are complete (see the two call sites above), and never for
 * `ctx.mode === "tui"` (enforced by `shouldForceHeadlessExit` itself) — an
 * interactive TUI session is never terminated by this policy.
 */
function maybeForceHeadlessExit(
  mode: ExtensionCommandContext["mode"],
  outcomeIsBenign: boolean,
  detail: string,
): void {
  const killSwitchEnabled = isHeadlessExitOnFailureEnabled(process.env as Record<string, string | undefined>);
  if (!shouldForceHeadlessExit({ mode, outcomeIsBenign, killSwitchEnabled })) return;
  writeSync(2, formatHeadlessFailureStderrLine(detail));
  process.exit(1);
}

function buildTriageDeps(
  pi: ExtensionAPI,
  notify: (message: string, level: "info" | "warning" | "error") => void,
): TriageRuntimeDeps {
  const execFn: ExecFn = (command, execArgs, options) => pi.exec(command, execArgs, options);
  const triageConfig = loadTriageConfig(process.env as Record<string, string | undefined>);
  return {
    exec: execFn,
    trackerDir: TRACKER_DIR,
    emptyHooksDir: EMPTY_HOOKS_DIR,
    config: triageConfig,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    newRunId: () => generateRunId(),
    readTranscriptIfUsable: makeReadTranscriptIfUsable(SESSIONS_DIR),
    isPaused: () => isPausedFlagSet(AGENT_DIR),
    // Reuse the exact Pi CLI that loaded this extension. Resolving a bare
    // `pi` through launchd's PATH can select an unrelated legacy install.
    investigate: makeRealInvestigator(
      execFn,
      process.argv[1] || "pi",
      INVESTIGATOR_SESSIONS_DIR,
      triageConfig.investigatorSessionRetention,
    ),
    notify,
  };
}

function describeTriageOutcome(outcome: TriageOutcome): {
  message: string;
  level: "info" | "warning" | "error";
} {
  switch (outcome.kind) {
    case "paused":
      return { message: "/triage-report is paused; run /triage-report resume to re-enable it.", level: "info" };
    case "tracker-not-ready":
      return { message: outcome.detail, level: "error" };
    case "lock-timeout":
      return {
        message: `Timed out waiting for the tracker lock; another /report or /triage-report operation may be running. ${outcome.detail}`,
        level: "warning",
      };
    case "dirty":
      return {
        message: `Tracker has uncommitted changes to .beads/issues.jsonl (phase: ${outcome.phase}); refusing to touch it. Recover or commit the tracker, then try again.`,
        level: "error",
      };
    case "no-candidate":
      return { message: "No eligible open pi-report tickets to triage right now.", level: "info" };
    case "claim-in-progress":
      return {
        message: `${outcome.id}: already has an active pi-triage claim; skipping this pass entirely (no candidate selection, no model call) until it finishes or its lease expires.`,
        level: "info",
      };
    case "transcript-missing":
      return {
        message: `${outcome.id}: recorded transcript is unavailable or unsafe to read (missing, wrong file type, or outside the trusted session directory). Left open with label triage:transcript-missing; skipped automated investigation.`,
        level: "warning",
      };
    case "blocked":
      return {
        message: `${outcome.id}: marked triage:blocked (${outcome.reason}). Left open for manual follow-up; will not be re-selected automatically.`,
        level: "warning",
      };
    case "completed":
      return {
        message: `${outcome.id}: automated investigation finished. Findings posted as a comment; labeled triage:needs-review and returned to open.`,
        level: "info",
      };
    case "failed-attempt":
      return {
        message: `${outcome.id}: investigation attempt ${outcome.attempt} failed; left claimed for a later retry once the claim lease expires.`,
        level: "warning",
      };
    case "deferred":
      return {
        message: `${outcome.id}: deferred (${outcome.reason}); left claimed for the next stale-recovery pass.`,
        level: "warning",
      };
    case "ownership-lost":
      return {
        message: `${outcome.id}: ownership changed before finalization (a stale-recovery pass or a human took the claim); left its current state untouched — no comment, no state change.`,
        level: "warning",
      };
    case "finalized-empty":
      return {
        message: `${outcome.id}: automated investigation finished but produced only empty/whitespace-only text — never treated as success. A diagnostic audit comment was posted; labeled triage:needs-review and returned to open. Not retried automatically.`,
        level: "warning",
      };
    default:
      return { message: `Unrecognized triage outcome: ${JSON.stringify(outcome)}`, level: "warning" };
  }
}

async function describeTriageStatus(pi: ExtensionAPI): Promise<string> {
  const paused = await isPausedFlagSet(AGENT_DIR);
  let candidateCount = "unknown (bd list failed)";
  let ownClaims: BdIssue[] = [];
  try {
    const candidatesRes = await pi.exec("bd", bdCandidatesArgs(), {
      cwd: TRACKER_DIR,
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (candidatesRes.code === 0) {
      try {
        candidateCount = String((parseBdJsonArray(candidatesRes.stdout) as BdIssue[]).length);
      } catch {
        candidateCount = "unknown (unparseable bd output)";
      }
    }
    const ownClaimsRes = await pi.exec(
      "bd",
      ["list", "--assignee", "pi-triage", "--status", "in_progress", "--limit", "0", "--json"],
      { cwd: TRACKER_DIR, timeout: COMMAND_TIMEOUT_MS },
    );
    if (ownClaimsRes.code === 0) {
      try {
        ownClaims = parseBdJsonArray(ownClaimsRes.stdout) as BdIssue[];
      } catch {
        // Leave ownClaims empty; the message below still reports the tracker/paused state.
      }
    }
  } finally {
    // `status` only issues read-only `bd list` queries, but Beads 1.0 has
    // been observed to trigger the same benign empty-export deletion quirk
    // (see `restoreBenignEmptyExportDeletion` in report-core.ts) as a side
    // effect of *list*, not just export, queries against a still-empty
    // tracker. `status` never runs a commit of its own to naturally
    // re-export/re-commit afterward, so without this, a freshly initialized
    // (zero-issue) tracker could be left looking dirty by nothing more than
    // running `/triage-report status` — and then have both `/report` and
    // `/triage-report run` refuse to make further changes. Run this in a
    // `finally` so it always fires, even if one of the `bd list` calls above
    // threw or returned a non-zero exit code.
    await restoreBenignEmptyExportDeletion(
      (command, args, options) => pi.exec(command, args, options),
      TRACKER_DIR,
      GIT_TIMEOUT_MS,
    ).catch(() => false);
  }

  return [
    `Tracker: ${TRACKER_DIR}`,
    `Paused: ${paused ? "yes" : "no"}`,
    `Eligible candidates: ${candidateCount}`,
    `Active pi-triage claims: ${ownClaims.length}${ownClaims.length > 0 ? " (" + ownClaims.map((i) => i.id).join(", ") + ")" : ""}`,
  ].join("\n");
}
