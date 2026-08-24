// Integration-style tests for the /triage-report orchestration. These run the
// real `bd` and `git` binaries against disposable temporary trackers (created
// via the real setup-tracker.sh, exactly like production) so the actual CLI
// flag/exit-code assumptions stay honest over time. The inner investigator is
// always a fake in-process function — these tests never spawn a real `pi`
// process, make a network call, or require model credentials.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHardenedCommitArgs } from "./report-core.ts";
import {
  loadTriageConfig,
  parseBdJsonArray,
  type BdIssue,
} from "./triage-core.ts";
import {
  type ExecFn,
  type ExecResult,
  type InvestigatorFn,
  type TriageRuntimeDeps,
  MutationLedger,
  PartialTriageError,
  boundedReadPlan,
  isPausedFlagSet,
  isTranscriptPathUsable,
  makeReadTranscriptIfUsable,
  makeRealInvestigator,
  pausedFlagPath,
  postAutomatedComment,
  pruneInvestigatorSessions,
  readBoundedTranscript,
  readTranscriptIfUsable,
  runTriageOnce,
  setPausedFlag,
} from "./triage-runtime.ts";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  if (process.env.TRIAGE_TEST_TRACE) console.error(`\u2192 starting: ${name}`);
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const REPORT_DIR = dirname(fileURLToPath(import.meta.url));

// ─── Real exec() over node:child_process, matching pi.exec's ExecResult ────

function realExec(env: Record<string, string | undefined>): ExecFn {
  return (command, args, options) =>
    new Promise<ExecResult>((resolve) => {
      execFile(
        command,
        args,
        {
          cwd: options?.cwd,
          timeout: options?.timeout,
          maxBuffer: 20 * 1024 * 1024,
          env: { ...process.env, ...env },
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
              ? ((error as unknown as { code: number }).code)
              : error
                ? 1
                : 0;
          resolve({
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            code,
            killed: Boolean((error as { killed?: boolean } | null)?.killed),
          });
        },
      );
    });
}

async function run(
  exec: ExecFn,
  command: string,
  args: string[],
  cwd: string,
): Promise<ExecResult> {
  const res = await exec(command, args, { cwd, timeout: 20_000 });
  if (res.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${res.code}): ${res.stderr || res.stdout}`);
  }
  return res;
}

// ─── Fixture tracker setup (reuses the real setup-tracker.sh) ─────────────

interface Fixture {
  dir: string;
  /** Scratch space for fixture files (e.g. fake transcripts) that must live
   *  outside the tracker's own git worktree so they never show up as
   *  untracked/dirty in `git status`. */
  scratchDir: string;
  /** Trusted session-transcript root used by `isTranscriptUsable` in tests.
   *  Real fixture transcripts live inside this directory; anything outside
   *  it exercises the trusted-path-boundary rejection path. */
  sessionsRoot: string;
  env: Record<string, string | undefined>;
  exec: ExecFn;
  cleanup: () => Promise<void>;
}

async function createFixtureTracker(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pi-triage-tracker-"));
  const scratchDir = await mkdtemp(join(tmpdir(), "pi-triage-scratch-"));
  // The entire scratch dir is the trusted session-transcript root in tests:
  // pre-existing fixtures write transcripts directly under `scratchDir`
  // (e.g. `join(fixture.scratchDir, "transcript.jsonl")`), so the boundary
  // must cover it directly rather than a nested subdirectory.
  const sessionsRoot = scratchDir;
  const globalConfigDir = await mkdtemp(join(tmpdir(), "pi-triage-gitconfig-"));
  const globalConfig = join(globalConfigDir, "gitconfig");
  await writeFile(
    globalConfig,
    "[user]\n  name = Pi Triage Test\n  email = pi-triage-test@example.invalid\n",
    "utf8",
  );
  const env: Record<string, string | undefined> = {
    GIT_CONFIG_GLOBAL: globalConfig,
    PI_REPORT_TRACKER_DIR: dir,
  };
  const exec = realExec(env);

  const setup = await exec(join(REPORT_DIR, "setup-tracker.sh"), [], { timeout: 30_000 });
  if (setup.code !== 0) {
    throw new Error(`setup-tracker.sh failed: ${setup.stderr || setup.stdout}`);
  }

  return {
    dir,
    scratchDir,
    sessionsRoot,
    env,
    exec,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(scratchDir, { recursive: true, force: true });
      await rm(globalConfigDir, { recursive: true, force: true });
    },
  };
}

interface FixtureIssueOptions {
  title?: string;
  priority?: number;
  reportTimestamp?: string;
  labels?: string[];
  issueType?: string;
  transcriptPath?: string | null;
  extraMetadata?: Record<string, unknown>;
}

async function createFixtureIssue(fixture: Fixture, opts: FixtureIssueOptions = {}): Promise<string> {
  const metadata = {
    schemaVersion: 1,
    source: "pi-report",
    reportTimestamp: opts.reportTimestamp ?? "2026-08-01T00:00:00.000Z",
    session: {
      id: "session-fixture",
      transcriptFile: opts.transcriptPath === undefined ? null : opts.transcriptPath,
    },
    git: null,
    ...opts.extraMetadata,
  };
  const labels = opts.labels ?? ["pi-report"];
  const res = await run(
    fixture.exec,
    "bd",
    [
      "create",
      "--title",
      opts.title ?? "Fixture report",
      "--type",
      opts.issueType ?? "bug",
      "--priority",
      `P${opts.priority ?? 2}`,
      "--labels",
      labels.join(","),
      "--description",
      "Fixture description",
      "--metadata",
      JSON.stringify(metadata),
      "--json",
    ],
    fixture.dir,
  );
  const created = JSON.parse(res.stdout) as { id: string };

  // Mirror /report's own createBead flow: `bd create` auto-stages an export,
  // but nothing commits it until the caller does so explicitly. Do that here
  // so every fixture starts from the same clean-tree state a real tracker is
  // always left in after a completed /report.
  await run(fixture.exec, "bd", ["export", "--no-memories", "--output", ".beads/issues.jsonl"], fixture.dir);
  await run(fixture.exec, "git", ["add", "-f", ".beads/issues.jsonl"], fixture.dir);
  await run(
    fixture.exec,
    "git",
    buildHardenedCommitArgs(join(fixture.dir, ".git", "pi-report-empty-hooks"), `report: ${created.id}`),
    fixture.dir,
  );

  return created.id;
}

async function showIssue(fixture: Fixture, id: string): Promise<BdIssue> {
  const res = await run(fixture.exec, "bd", ["show", id, "--json"], fixture.dir);
  const values = parseBdJsonArray(res.stdout) as BdIssue[];
  const issue = values[0];
  if (!issue) throw new Error(`bd show ${id} returned nothing`);
  return issue;
}

async function listComments(fixture: Fixture, id: string): Promise<{ text: string; author?: string }[]> {
  const res = await run(fixture.exec, "bd", ["comments", id, "--json"], fixture.dir);
  return parseBdJsonArray(res.stdout) as { text: string; author?: string }[];
}

async function gitLogSubjects(fixture: Fixture): Promise<string[]> {
  const res = await run(fixture.exec, "git", ["log", "--pretty=%s"], fixture.dir);
  return res.stdout.trim().split("\n").filter(Boolean);
}

async function gitPorcelainStatus(fixture: Fixture): Promise<string> {
  const res = await run(fixture.exec, "git", ["status", "--porcelain"], fixture.dir);
  return res.stdout;
}

/**
 * `bd` mutating commands (create, update, comment, set-state, ...) auto-stage
 * an export of `.beads/issues.jsonl` as a convenience, but never commit it.
 * Test fixtures that mutate the tracker directly (bypassing the real
 * /triage-report or /report commit flow) must settle that staged export so
 * the tree starts clean, exactly like a real tracker always is between
 * completed /report or /triage-report runs.
 */
async function settleTrackerState(fixture: Fixture, message: string): Promise<void> {
  await run(fixture.exec, "bd", ["export", "--no-memories", "--output", ".beads/issues.jsonl"], fixture.dir);
  const status = await gitPorcelainStatus(fixture);
  if (status.trim() === "") return;
  await run(fixture.exec, "git", ["add", "-f", ".beads/issues.jsonl"], fixture.dir);
  await run(
    fixture.exec,
    "git",
    buildHardenedCommitArgs(join(fixture.dir, ".git", "pi-report-empty-hooks"), message),
    fixture.dir,
  );
}

// ─── Deps builder ────────────────────────────────────────────────────────

function makeCountingInvestigator(fn: InvestigatorFn): { investigate: InvestigatorFn; count: () => number } {
  let calls = 0;
  return {
    investigate: async (prompt, opts) => {
      calls++;
      return fn(prompt, opts);
    },
    count: () => calls,
  };
}

function baseDeps(fixture: Fixture, investigate: InvestigatorFn, config = loadTriageConfig({})): TriageRuntimeDeps {
  return {
    exec: fixture.exec,
    trackerDir: fixture.dir,
    emptyHooksDir: join(fixture.dir, ".git", "pi-report-empty-hooks"),
    config,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    newRunId: () => `run-${Math.random().toString(36).slice(2)}`,
    readTranscriptIfUsable: makeReadTranscriptIfUsable(fixture.sessionsRoot),
    isPaused: async () => false,
    investigate,
    notify: () => {},
  };
}

/**
 * Wraps a real fixture `ExecFn` with a fault injector: any call matching
 * `shouldFail` returns a synthetic non-zero exit instead of reaching the
 * real `bd`/`git` binary; everything else passes through untouched. Used to
 * prove the specific "a write already landed, the next one fails" partial-
 * state window is always surfaced as `PartialTriageError`, never silently
 * absorbed.
 */
function injectFault(
  exec: ExecFn,
  shouldFail: (command: string, args: string[]) => boolean,
  message = "synthetic fault injected by test",
): ExecFn {
  return async (command, args, options) => {
    if (shouldFail(command, args)) {
      return { stdout: "", stderr: message, code: 17 };
    }
    return exec(command, args, options);
  };
}

/**
 * Passes every call through to the real `exec` unchanged, but records the
 * exact argv of any call matching `match` — used to assert on precisely
 * what a real `bd`/`git` subprocess call actually received (e.g. a `bd
 * set-state --reason <value>` argument), rather than only on the pure
 * builder function's output in isolation.
 */
function captureExecCalls(
  exec: ExecFn,
  match: (command: string, args: string[]) => boolean,
): { exec: ExecFn; calls: () => string[][] } {
  const calls: string[][] = [];
  return {
    exec: async (command, args, options) => {
      if (match(command, args)) calls.push(args);
      return exec(command, args, options);
    },
    calls: () => calls,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

await test("no eligible candidate: no-candidate outcome and the investigator is never called", async () => {
  const fixture = await createFixtureTracker();
  try {
    const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "unused" }));
    const outcome = await runTriageOnce(baseDeps(fixture, investigate));
    assert.equal(outcome.kind, "no-candidate");
    assert.equal(count(), 0);
  } finally {
    await fixture.cleanup();
  }
});

await test("paused: paused outcome, no bd/git mutation, investigator never called", async () => {
  const fixture = await createFixtureTracker();
  try {
    await createFixtureIssue(fixture, { transcriptPath: "/nonexistent" });
    const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "unused" }));
    const deps = baseDeps(fixture, investigate);
    deps.isPaused = async () => true;
    const before = await gitLogSubjects(fixture);
    const outcome = await runTriageOnce(deps);
    assert.equal(outcome.kind, "paused");
    assert.equal(count(), 0);
    assert.deepEqual(await gitLogSubjects(fixture), before);
  } finally {
    await fixture.cleanup();
  }
});

await test("dirty tracker: refuses to mutate and never calls the investigator", async () => {
  const fixture = await createFixtureTracker();
  try {
    await createFixtureIssue(fixture);
    // Simulate an unrelated dirty file outside our own lock convention.
    await writeFile(join(fixture.dir, "README.md"), "dirtied by test\n", "utf8");
    const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "unused" }));
    const outcome = await runTriageOnce(baseDeps(fixture, investigate));
    assert.equal(outcome.kind, "dirty");
    assert.equal(count(), 0);
  } finally {
    await fixture.cleanup();
  }
});

await test("candidate ordering: highest priority (lowest number), then oldest created_at, wins", async () => {
  const fixture = await createFixtureTracker();
  try {
    await createFixtureIssue(fixture, { title: "low priority", priority: 3, transcriptPath: "/nonexistent-a" });
    // `bd`-assigned `created_at` (not the self-reported `reportTimestamp`
    // metadata) drives ordering, so create the intended winner strictly
    // before its higher-priority-tie competitor, with a small gap to avoid
    // any timestamp-resolution flakiness.
    const olderHighPriority = await createFixtureIssue(fixture, {
      title: "older high priority",
      priority: 1,
      transcriptPath: "/nonexistent-c",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const newerHighPriority = await createFixtureIssue(fixture, {
      title: "newer high priority",
      priority: 1,
      transcriptPath: "/nonexistent-b",
    });

    const { investigate } = makeCountingInvestigator(async () => ({ ok: true, text: "unused" }));
    const outcome = await runTriageOnce(baseDeps(fixture, investigate));
    // Both high-priority issues lack a transcript, so this resolves via the
    // transcript-missing short circuit rather than "claimed" — but the id it
    // picked still proves selection ordering.
    assert.ok(outcome.kind === "transcript-missing" || outcome.kind === "claimed");
    assert.equal((outcome as { id: string }).id, olderHighPriority);
    assert.notEqual((outcome as { id: string }).id, newerHighPriority);
  } finally {
    await fixture.cleanup();
  }
});

await test("candidate ordering: a non-bug issue_type is excluded even if otherwise eligible", async () => {
  const fixture = await createFixtureTracker();
  try {
    await createFixtureIssue(fixture, {
      title: "not actually a bug",
      priority: 0,
      issueType: "task",
      transcriptPath: "/nonexistent-task",
    });
    const realBug = await createFixtureIssue(fixture, {
      title: "a real bug",
      priority: 2,
      transcriptPath: "/nonexistent-bug",
    });

    const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "unused" }));
    const outcome = await runTriageOnce(baseDeps(fixture, investigate));
    assert.equal(outcome.kind, "transcript-missing");
    assert.equal((outcome as { id: string }).id, realBug);
    assert.equal(count(), 0);
  } finally {
    await fixture.cleanup();
  }
});

await test("exclusion: labeled/claimed/blocked/needs-review/non-open issues are never selected", async () => {
  const fixture = await createFixtureTracker();
  try {
    await createFixtureIssue(fixture, { labels: ["pi-report", "triage:claimed"] });
    await createFixtureIssue(fixture, { labels: ["pi-report", "triage:needs-review"] });
    await createFixtureIssue(fixture, { labels: ["pi-report", "triage:blocked"] });
    await createFixtureIssue(fixture, { labels: ["pi-report", "triage:transcript-missing"] });
    await createFixtureIssue(fixture, { labels: ["not-pi-report"] });

    const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "unused" }));
    const outcome = await runTriageOnce(baseDeps(fixture, investigate));
    assert.equal(outcome.kind, "no-candidate");
    assert.equal(count(), 0);
  } finally {
    await fixture.cleanup();
  }
});

await test("missing transcript: transcript-missing outcome, no investigator call, tracker left clean", async () => {
  const fixture = await createFixtureTracker();
  try {
    const id = await createFixtureIssue(fixture, { transcriptPath: "/definitely/does/not/exist.jsonl" });
    const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "unused" }));
    const outcome = await runTriageOnce(baseDeps(fixture, investigate));
    assert.deepEqual(outcome, { kind: "transcript-missing", id });
    assert.equal(count(), 0);

    const issue = await showIssue(fixture, id);
    assert.equal(issue.status, "open");
    assert.ok((issue.labels ?? []).includes("triage:transcript-missing"));
    assert.ok(!(issue.labels ?? []).includes("triage:claimed"));

    const comments = await listComments(fixture, id);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.text, /transcript is unavailable|could not find the recorded session transcript/i);

    assert.equal((await gitPorcelainStatus(fixture)).trim(), "");
    assert.deepEqual(await gitLogSubjects(fixture), [
      `triage: transcript-missing ${id}`,
      `report: ${id}`,
      "Initialize Pi reports tracker",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

await test("happy path: claim -> investigate -> findings comment -> needs-review -> open, clean tree", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, '{"type":"user","text":"it broke"}\n', "utf8");
    const id = await createFixtureIssue(fixture, { transcriptPath });

    const { investigate } = makeCountingInvestigator(async () => ({
      ok: true,
      text: "Root cause: the widget overheated.",
    }));
    const notifications: string[] = [];
    const deps = baseDeps(fixture, investigate);
    deps.notify = (message) => notifications.push(message);
    const outcome = await runTriageOnce(deps);
    assert.deepEqual(outcome, { kind: "completed", id });
    assert.ok(
      notifications.some((message) => message.includes(`${id}: claim committed`) && message.includes("may take several minutes")),
      "a claimed report must emit progress before the investigator is awaited",
    );

    const issue = await showIssue(fixture, id);
    assert.equal(issue.status, "open");
    assert.equal(issue.assignee, undefined);
    assert.ok((issue.labels ?? []).includes("triage:needs-review"));
    assert.ok(!(issue.labels ?? []).includes("triage:claimed"));
    assert.equal(issue.metadata?.triageRunId, undefined);
    assert.equal(issue.metadata?.triageAttempt, undefined);

    const comments = await listComments(fixture, id);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.text, /Root cause: the widget overheated\./);
    assert.match(comments[0]!.text, /pi-triage: run=/);

    assert.equal((await gitPorcelainStatus(fixture)).trim(), "");
    const subjects = await gitLogSubjects(fixture);
    assert.deepEqual(subjects, [
      `triage: findings ${id}`,
      `triage: claim ${id}`,
      `report: ${id}`,
      "Initialize Pi reports tracker",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

await test("BLOCKER regression: a huge (>=100,000 char) stopReason in the investigator's audit data never reaches the real posted comment unbounded, even on a successful finding", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, '{"type":"user","text":"it broke"}\n', "utf8");
    const id = await createFixtureIssue(fixture, { transcriptPath });

    const hugeStopReason = "R".repeat(100_000);
    assert.ok(hugeStopReason.length >= 100_000, "fixture must actually be huge");
    const { investigate } = makeCountingInvestigator(async () => ({
      ok: true,
      text: "Root cause: the widget overheated.",
      audit: {
        sessionId: "pi-triage-run-1-a1",
        sessionFile: "/tmp/fake-session.jsonl",
        stopReason: hugeStopReason,
        errorMessage: null,
        exitCode: 0,
        killed: false,
        stdoutBytes: 10,
        stderrBytes: 0,
        stdoutSha256: "c".repeat(64),
        stderrSha256: "d".repeat(64),
        stdoutExcerpt: "",
        stderrExcerpt: "",
        malformedLineCount: 0,
      },
    }));

    const outcome = await runTriageOnce(baseDeps(fixture, investigate));
    assert.deepEqual(outcome, { kind: "completed", id });

    // Fetch the *actual* posted comment back via a real `bd comments` read,
    // not just the pure `formatAuditBlock` builder's return value in
    // isolation.
    const comments = await listComments(fixture, id);
    assert.equal(comments.length, 1);
    const commentText = comments[0]!.text;
    assert.ok(!commentText.includes(hugeStopReason), "the posted comment must never carry the full stopReason");
    assert.ok(commentText.length < 5_000, `expected a bounded comment, got ${commentText.length} chars`);
    assert.match(commentText, /\u2026 \(truncated;/, "expected a truncation marker in the posted comment");
    assert.match(commentText, /Root cause: the widget overheated\./, "the real findings text must still be present and untouched");
  } finally {
    await fixture.cleanup();
  }
});

await test("empty/whitespace-only investigator text is never treated as success: finalized-empty, needs-review, open, no retry", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, '{"type":"user","text":"it broke"}\n', "utf8");
    const id = await createFixtureIssue(fixture, { transcriptPath });

    // A whitespace/Unicode-invisible-only "success" from the investigator
    // (process exit 0, no reported execution error) must never be finalized
    // as `completed`: this is the distinct, no-retry `finalized-empty` path.
    const { investigate, count } = makeCountingInvestigator(async () => ({
      ok: true,
      text: "   \u200B\n\t  ",
      audit: {
        sessionId: "pi-triage-run-empty-a1",
        sessionFile: "/tmp/fake-session.jsonl",
        stopReason: "stop",
        errorMessage: null,
        exitCode: 0,
        killed: false,
        stdoutBytes: 10,
        stderrBytes: 0,
        stdoutSha256: "c".repeat(64),
        stderrSha256: "d".repeat(64),
        stdoutExcerpt: "",
        stderrExcerpt: "",
        malformedLineCount: 0,
      },
    }));
    const config = loadTriageConfig({ PI_TRIAGE_MAX_ATTEMPTS: "3" });
    const outcome = await runTriageOnce(baseDeps(fixture, investigate, config));
    assert.deepEqual(outcome, { kind: "finalized-empty", id });
    assert.equal(count(), 1);

    const issue = await showIssue(fixture, id);
    // Released to open, not left claimed for an automatic retry — unlike a
    // genuine investigator execution failure below max attempts.
    assert.equal(issue.status, "open");
    assert.equal(issue.assignee, undefined);
    assert.ok((issue.labels ?? []).includes("triage:needs-review"));
    assert.ok(!(issue.labels ?? []).includes("triage:claimed"));
    assert.equal(issue.metadata?.triageRunId, undefined);
    assert.equal(issue.metadata?.triageAttempt, undefined);

    const comments = await listComments(fixture, id);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.text, /empty or whitespace-only/i);
    assert.match(comments[0]!.text, /pi-triage-run-empty-a1/);
    assert.match(comments[0]!.text, /pi-triage: run=/);

    assert.equal((await gitPorcelainStatus(fixture)).trim(), "");
    const subjects = await gitLogSubjects(fixture);
    assert.deepEqual(subjects, [
      `triage: empty-findings ${id}`,
      `triage: claim ${id}`,
      `report: ${id}`,
      "Initialize Pi reports tracker",
    ]);

    // A later pass must not re-select or retry it: finalized-empty is a
    // deliberate terminal outcome for that attempt, not a transient failure.
    const nextOutcome = await runTriageOnce(baseDeps(fixture, investigate, config));
    assert.equal(nextOutcome.kind, "no-candidate");
    assert.equal(count(), 1, "the investigator must not be invoked again for an already-finalized-empty report");
  } finally {
    await fixture.cleanup();
  }
});

await test("investigator failure below max attempts: failed-attempt, issue stays claimed", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, "{}\n", "utf8");
    const id = await createFixtureIssue(fixture, { transcriptPath });

    const { investigate } = makeCountingInvestigator(async () => ({ ok: false, text: "", error: "model timed out" }));
    const config = loadTriageConfig({ PI_TRIAGE_MAX_ATTEMPTS: "3" });
    const outcome = await runTriageOnce(baseDeps(fixture, investigate, config));
    assert.deepEqual(outcome, { kind: "failed-attempt", id, attempt: 1 });

    const issue = await showIssue(fixture, id);
    assert.equal(issue.status, "in_progress");
    assert.equal(issue.assignee, "pi-triage");
    assert.equal(issue.metadata?.triageAttempt, 1);
    assert.ok((issue.labels ?? []).includes("triage:claimed"));

    // No comment was posted for a non-terminal failure.
    assert.equal((await listComments(fixture, id)).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

await test("investigator failure at max attempts: blocked immediately, with an explanatory comment", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, "{}\n", "utf8");
    const id = await createFixtureIssue(fixture, { transcriptPath });

    const { investigate } = makeCountingInvestigator(async () => ({ ok: false, text: "", error: "boom" }));
    const config = loadTriageConfig({ PI_TRIAGE_MAX_ATTEMPTS: "1" });
    const outcome = await runTriageOnce(baseDeps(fixture, investigate, config));
    assert.deepEqual(outcome, { kind: "blocked", id, reason: "investigator-failed" });

    const issue = await showIssue(fixture, id);
    assert.equal(issue.status, "open");
    assert.equal(issue.assignee, undefined);
    assert.ok((issue.labels ?? []).includes("triage:blocked"));

    const comments = await listComments(fixture, id);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.text, /investigator failed: boom/);
  } finally {
    await fixture.cleanup();
  }
});

await test("BLOCKER regression: a huge (>=100,000 char) commandError-derived investigator failure detail never reaches the real bd set-state --reason value or the posted blocked comment unbounded", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, "{}\n", "utf8");
    const id = await createFixtureIssue(fixture, { transcriptPath });

    // Simulates exactly what `commandError` would produce for a real
    // investigator subprocess that wrote a huge amount of raw stderr (e.g.
    // an unbounded stack trace or verbose provider error dump) — the exact
    // shape that reaches `finalizeFailure`'s `errorMessage` parameter in
    // production, well over 100,000 characters.
    const hugeStderr = "synthetic provider error line ".repeat(4_000);
    assert.ok(hugeStderr.length >= 100_000, "fixture must actually be huge");
    const hugeError = `pi --mode json (investigator) failed with exit code 1: ${hugeStderr}`;

    const { investigate } = makeCountingInvestigator(async () => ({ ok: false, text: "", error: hugeError }));
    const config = loadTriageConfig({ PI_TRIAGE_MAX_ATTEMPTS: "1" });

    // Filter specifically for the "blocked" state transition: claiming the
    // ticket also issues its own, unrelated `bd set-state` call (setting
    // `triage:claimed`), which must not be confused with the one that
    // actually embeds this test's huge `cause` via `blockedReason`.
    const spy = captureExecCalls(
      fixture.exec,
      (command, args) => command === "bd" && args[0] === "set-state" && args.includes("triage=blocked"),
    );
    const deps = baseDeps(fixture, investigate, config);
    deps.exec = spy.exec;

    const outcome = await runTriageOnce(deps);
    assert.deepEqual(outcome, { kind: "blocked", id, reason: "investigator-failed" });

    // The actual argv sent to the real `bd set-state` subprocess call must
    // never carry the huge string.
    const setStateCalls = spy.calls();
    assert.equal(setStateCalls.length, 1);
    const reasonIndex = setStateCalls[0]!.indexOf("--reason");
    assert.ok(reasonIndex >= 0, "expected a --reason flag in the bd set-state argv");
    const reasonValue = setStateCalls[0]![reasonIndex + 1]!;
    assert.ok(reasonValue.length < 1_000, `expected a bounded --reason value, got ${reasonValue.length} chars`);
    assert.ok(!reasonValue.includes(hugeStderr), "the real bd set-state --reason value must never carry the full stderr");

    // The actual comment posted to Beads (fetched back via a real `bd
    // comments` read, not just the pure builder's return value) must also
    // stay bounded and never carry the huge string.
    const comments = await listComments(fixture, id);
    assert.equal(comments.length, 1);
    const commentText = comments[0]!.text;
    assert.ok(!commentText.includes(hugeStderr), "the posted blocked comment must never carry the full stderr");
    assert.ok(
      commentText.length < 5_000,
      `expected a bounded comment body (aside from the fixed audit-block/footer text), got ${commentText.length} chars`,
    );
    assert.match(commentText, /\u2026 \(truncated;/, "expected the truncation marker to be present in the posted comment");

    const issue = await showIssue(fixture, id);
    assert.ok((issue.labels ?? []).includes("triage:blocked"));
  } finally {
    await fixture.cleanup();
  }
});

await test("stale claim recovery: same run id, incremented attempt, resumes and completes", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, "{}\n", "utf8");
    const id = await createFixtureIssue(fixture, { transcriptPath });

    // First attempt fails and leaves the issue claimed.
    const failing = makeCountingInvestigator(async () => ({ ok: false, text: "", error: "first try failed" }));
    const config = loadTriageConfig({ PI_TRIAGE_MAX_ATTEMPTS: "3", PI_TRIAGE_LEASE_MS: "1" });
    const firstOutcome = await runTriageOnce(baseDeps(fixture, failing.investigate, config));
    assert.equal(firstOutcome.kind, "failed-attempt");
    const firstRunId = (await showIssue(fixture, id)).metadata?.triageRunId;
    assert.equal(typeof firstRunId, "string");

    // Lease is 1ms, so the claim is immediately stale for the next pass.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const succeeding = makeCountingInvestigator(async () => ({ ok: true, text: "Recovered finding." }));
    const secondOutcome = await runTriageOnce(baseDeps(fixture, succeeding.investigate, config));
    assert.deepEqual(secondOutcome, { kind: "completed", id });
    assert.equal(succeeding.count(), 1);

    const issue = await showIssue(fixture, id);
    assert.equal(issue.status, "open");
    assert.ok((issue.labels ?? []).includes("triage:needs-review"));

    const comments = await listComments(fixture, id);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.text, new RegExp(`pi-triage: run=${firstRunId} attempt=2`));

    const subjects = await gitLogSubjects(fixture);
    assert.deepEqual(subjects, [
      `triage: findings ${id}`,
      `triage: retry-claim ${id}`,
      `triage: claim ${id}`,
      `report: ${id}`,
      "Initialize Pi reports tracker",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

await test("investigator failure at max attempts (fresh claim): blocked immediately, without exercising stale recovery", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, "{}\n", "utf8");
    const id = await createFixtureIssue(fixture, { transcriptPath });

    const config = loadTriageConfig({ PI_TRIAGE_MAX_ATTEMPTS: "1", PI_TRIAGE_LEASE_MS: "1" });
    const first = makeCountingInvestigator(async () => ({ ok: false, text: "", error: "fails once" }));
    const firstOutcome = await runTriageOnce(baseDeps(fixture, first.investigate, config));
    // With maxAttempts=1, the very first failure already blocks via
    // `finalizeFailure`'s own max-attempts check — this never goes through
    // `recoverStaleClaim` at all (the claim is fresh, not stale). See the
    // dedicated stale-recovery-at-max-attempts test below for that path.
    assert.deepEqual(firstOutcome, { kind: "blocked", id, reason: "investigator-failed" });

    // Re-run should see a clean, non-claimed, blocked issue: no-candidate, no investigator call.
    const second = makeCountingInvestigator(async () => ({ ok: true, text: "should not be called" }));
    const secondOutcome = await runTriageOnce(baseDeps(fixture, second.investigate, config));
    assert.equal(secondOutcome.kind, "no-candidate");
    assert.equal(second.count(), 0);
  } finally {
    await fixture.cleanup();
  }
});

await test("stale claim recovery at max attempts: truly exercises recoverStaleClaim's blocked-without-reclaiming branch", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, "{}\n", "utf8");
    const id = await createFixtureIssue(fixture, { transcriptPath });

    // Pass 1: a permissive maxAttempts so the first failure leaves the issue
    // actively claimed (attempt=1), not blocked.
    const permissive = loadTriageConfig({ PI_TRIAGE_MAX_ATTEMPTS: "5", PI_TRIAGE_LEASE_MS: "1" });
    const first = makeCountingInvestigator(async () => ({ ok: false, text: "", error: "first try failed" }));
    const firstOutcome = await runTriageOnce(baseDeps(fixture, first.investigate, permissive));
    assert.deepEqual(firstOutcome, { kind: "failed-attempt", id, attempt: 1 });

    const afterFirst = await showIssue(fixture, id);
    assert.equal(afterFirst.status, "in_progress");
    assert.equal(afterFirst.metadata?.triageAttempt, 1);

    // Lease is 1ms: the claim is immediately stale for the next pass.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Pass 2: a *tighter* maxAttempts (1) means the stale claim's next
    // attempt (2) already exceeds it. This must take the
    // `recoverStaleClaim` "stale claim exceeded the maximum retry count"
    // branch directly — never re-claiming, never calling the investigator.
    const tight = loadTriageConfig({ PI_TRIAGE_MAX_ATTEMPTS: "1", PI_TRIAGE_LEASE_MS: "1" });
    const second = makeCountingInvestigator(async () => ({ ok: true, text: "must never run" }));
    const secondOutcome = await runTriageOnce(baseDeps(fixture, second.investigate, tight));
    assert.deepEqual(secondOutcome, { kind: "blocked", id, reason: "max-attempts" });
    assert.equal(second.count(), 0, "the investigator must never be invoked on this path");

    const issue = await showIssue(fixture, id);
    assert.equal(issue.status, "open");
    assert.equal(issue.assignee, undefined);
    assert.ok((issue.labels ?? []).includes("triage:blocked"));
    assert.ok(!(issue.labels ?? []).includes("triage:claimed"));

    const comments = await listComments(fixture, id);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.text, /stale claim exceeded the maximum retry count/);

    // Re-run should now be a clean no-candidate/no-op.
    const third = makeCountingInvestigator(async () => ({ ok: true, text: "still must never run" }));
    const thirdOutcome = await runTriageOnce(baseDeps(fixture, third.investigate, tight));
    assert.equal(thirdOutcome.kind, "no-candidate");
    assert.equal(third.count(), 0);
  } finally {
    await fixture.cleanup();
  }
});

await test("comment cap: reaching the automated-comment cap blocks without a new comment", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, "{}\n", "utf8");
    const id = await createFixtureIssue(fixture, {
      transcriptPath,
      extraMetadata: {},
    });
    // Pre-seed two automated-looking comments to hit a cap of 2 immediately.
    for (let i = 0; i < 2; i++) {
      await run(
        fixture.exec,
        "bd",
        ["comment", id, `pre-existing automated note pi-triage: run=seed-${i} attempt=1 sha256=deadbeef`],
        fixture.dir,
      );
    }
    await settleTrackerState(fixture, "test fixture: seed automated comments");

    const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "should not run" }));
    const config = loadTriageConfig({ PI_TRIAGE_MAX_COMMENTS: "2" });
    const outcome = await runTriageOnce(baseDeps(fixture, investigate, config));
    assert.deepEqual(outcome, { kind: "blocked", id, reason: "automated-comment-cap" });
    assert.equal(count(), 0);

    const comments = await listComments(fixture, id);
    assert.equal(comments.length, 2, "no additional comment should have been added");

    const issue = await showIssue(fixture, id);
    assert.ok((issue.labels ?? []).includes("triage:blocked"));
  } finally {
    await fixture.cleanup();
  }
});

await test("duplicate-comment recovery: re-posting the same run id is a no-op", async () => {
  const fixture = await createFixtureTracker();
  try {
    const id = await createFixtureIssue(fixture);
    const deps = baseDeps(fixture, async () => ({ ok: true, text: "unused" }));

    const first = await postAutomatedComment(deps, id, "run-dup", 1, "Same finding text.");
    assert.deepEqual(first, { posted: true });
    const second = await postAutomatedComment(deps, id, "run-dup", 1, "Same finding text.");
    assert.deepEqual(second, { posted: false, skippedReason: "already posted for this run" });

    const comments = await listComments(fixture, id);
    assert.equal(comments.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

await test("concurrency: two simultaneous runs against one candidate never double-claim it", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, "{}\n", "utf8");
    const id = await createFixtureIssue(fixture, { transcriptPath });

    const slowInvestigator: InvestigatorFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true, text: "Concurrent finding." };
    };

    const [a, b] = await Promise.all([
      runTriageOnce(baseDeps(fixture, slowInvestigator)),
      runTriageOnce(baseDeps(fixture, slowInvestigator)),
    ]);

    const kinds = [a.kind, b.kind].sort();
    // The loser observes the winner's fresh, non-stale active claim and
    // returns a deliberate no-op ("claim-in-progress") rather than falling
    // through to "no-candidate" by exclusion-label coincidence.
    assert.deepEqual(kinds, ["claim-in-progress", "completed"]);
    const loser = a.kind === "claim-in-progress" ? a : b;
    assert.equal((loser as { id: string }).id, id);

    const comments = await listComments(fixture, id);
    assert.equal(comments.length, 1, "exactly one findings comment must exist, never two");

    const issue = await showIssue(fixture, id);
    assert.equal(issue.status, "open");
    assert.ok((issue.labels ?? []).includes("triage:needs-review"));
  } finally {
    await fixture.cleanup();
  }
});

await test("active non-stale claim blocks a *different* eligible candidate: deliberate no-op, no model call (blocker: no-op even with two candidates)", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, "{}\n", "utf8");
    const claimedId = await createFixtureIssue(fixture, { title: "already being investigated", priority: 1, transcriptPath });
    const otherId = await createFixtureIssue(fixture, { title: "a different eligible ticket", priority: 1, transcriptPath });

    // Pass 1 claims `claimedId` and, with a failing investigator below the
    // attempt cap, leaves it actively (non-stale) claimed.
    const permissive = loadTriageConfig({ PI_TRIAGE_MAX_ATTEMPTS: "5", PI_TRIAGE_LEASE_MS: "999999999" });
    const first = makeCountingInvestigator(async () => ({ ok: false, text: "", error: "still investigating" }));
    const firstOutcome = await runTriageOnce(baseDeps(fixture, first.investigate, permissive));
    assert.deepEqual(firstOutcome, { kind: "failed-attempt", id: claimedId, attempt: 1 });

    const claimed = await showIssue(fixture, claimedId);
    assert.equal(claimed.status, "in_progress");
    assert.equal(claimed.assignee, "pi-triage");

    // Pass 2: `otherId` is a distinct, eligible, equal-priority candidate
    // that a naive "only skip if *this* ticket is stale" check would happily
    // select. It must not be selected, claimed, or investigated: only one
    // triage investigation may be in flight at a time.
    const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "must never run" }));
    const secondOutcome = await runTriageOnce(baseDeps(fixture, investigate, permissive));
    assert.deepEqual(secondOutcome, { kind: "claim-in-progress", id: claimedId });
    assert.equal(count(), 0, "the model must never be invoked while another claim is active");

    const other = await showIssue(fixture, otherId);
    assert.equal(other.status, "open");
    assert.equal(other.assignee, undefined);
    assert.ok(!(other.labels ?? []).includes("triage:claimed"), "the other candidate must be left completely untouched");
  } finally {
    await fixture.cleanup();
  }
});

await test("PartialTriageError: a write that lands followed by a failing write is escalated with the issue id, never silently absorbed", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, "{}\n", "utf8");
    const id = await createFixtureIssue(fixture, { transcriptPath });

    // The claim (`bd update --claim`) is allowed to land for real; only the
    // very next write in the same operation — the defensive `bd set-state
    // triage=claimed` label self-heal — is forced to fail synthetically.
    const faultyExec = injectFault(fixture.exec, (command, args) => command === "bd" && args[0] === "set-state");
    const deps = baseDeps(fixture, async () => ({ ok: true, text: "unused: must not be reached" }));
    deps.exec = faultyExec;

    await assert.rejects(
      () => runTriageOnce(deps),
      (error: unknown) => {
        assert.ok(error instanceof PartialTriageError, `expected PartialTriageError, got ${String(error)}`);
        assert.equal((error as PartialTriageError).id, id);
        assert.match((error as PartialTriageError).message, /bd set-state/);
        return true;
      },
    );

    // The earlier write really did land in Beads even though the operation
    // as a whole threw — this is the partial state the error exists to make
    // visible, not something that should have been rolled back invisibly.
    const issue = await showIssue(fixture, id);
    assert.equal(issue.status, "in_progress");
    assert.equal(issue.assignee, "pi-triage");

    // A later, uninstrumented pass must not silently absorb or paper over
    // that partial state either: `bd update --claim` alone does not stage
    // any export (verified empirically), so the tree itself stays clean,
    // but the claim it already made is still active. The very "active,
    // non-stale claim blocks everything else" no-op guard (blocker 1) is
    // what actually protects this window: the next pass must see that
    // still-active claim and refuse to select a new candidate or call the
    // model, rather than treating the earlier failure as if nothing had
    // happened.
    const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "must not run" }));
    const nextOutcome = await runTriageOnce(baseDeps(fixture, investigate));
    assert.deepEqual(nextOutcome, { kind: "claim-in-progress", id });
    assert.equal(count(), 0);
  } finally {
    await fixture.cleanup();
  }
});

await test("ownership-lost: if ownership changes while the investigator was running, finalization never touches the new owner's state", async () => {
  const fixture = await createFixtureTracker();
  try {
    const transcriptPath = join(fixture.scratchDir, "transcript.jsonl");
    await writeFile(transcriptPath, "{}\n", "utf8");
    const id = await createFixtureIssue(fixture, { transcriptPath });

    // The investigator itself simulates a concurrent ownership change (e.g.
    // a stale-recovery pass bumping the attempt) while it is "running"
    // outside the claim/finalize lock.
    const hijacking: InvestigatorFn = async () => {
      await run(
        fixture.exec,
        "bd",
        ["update", id, "--set-metadata", "triageAttempt=99", "--actor", "pi-triage", "--json"],
        fixture.dir,
      );
      await settleTrackerState(fixture, "test fixture: simulate a concurrent ownership change");
      return { ok: true, text: "Should never be posted." };
    };

    const outcome = await runTriageOnce(baseDeps(fixture, hijacking));
    assert.deepEqual(outcome, { kind: "ownership-lost", id });

    const comments = await listComments(fixture, id);
    assert.equal(comments.length, 0, "no comment may ever be posted once ownership changed");

    const issue = await showIssue(fixture, id);
    assert.equal(issue.status, "in_progress");
    assert.equal(issue.metadata?.triageAttempt, 99, "the new owner's state must be left completely untouched");
    assert.ok(!(issue.labels ?? []).includes("triage:needs-review"));
  } finally {
    await fixture.cleanup();
  }
});

await test("no-candidate path self-heals a benign empty-export deletion instead of treating it as blocking dirt (Beads 1.0 workaround, reused from /report)", async () => {
  const fixture = await createFixtureTracker();
  try {
    // Freshly initialized tracker: zero issues, `.beads/issues.jsonl`
    // committed empty by setup-tracker.sh. Simulate the known Beads 1.0
    // quirk where some export/list operations delete that tracked-but-empty
    // file.
    await rm(join(fixture.dir, ".beads", "issues.jsonl"), { force: true });
    const preStatus = await run(
      fixture.exec,
      "git",
      ["status", "--porcelain", "--", ".beads/issues.jsonl"],
      fixture.dir,
    );
    assert.notEqual(preStatus.stdout.trim(), "", "the simulated deletion must show up as real git dirt first");

    const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "unused" }));
    const outcome = await runTriageOnce(baseDeps(fixture, investigate));
    assert.equal(outcome.kind, "no-candidate");
    assert.equal(count(), 0);

    assert.equal(
      (await gitPorcelainStatus(fixture)).trim(),
      "",
      "the benign deletion must have been healed by isTrackerDirty's reused workaround, not left as blocking dirt",
    );
    const restored = await readFile(join(fixture.dir, ".beads", "issues.jsonl"), "utf8");
    assert.equal(restored, "");
  } finally {
    await fixture.cleanup();
  }
});

await test("transcript trust boundary: a path outside the trusted session root is treated as unsafe, deterministically, without invoking the model", async () => {
  const fixture = await createFixtureTracker();
  try {
    const outsideDir = await mkdtemp(join(tmpdir(), "pi-triage-outside-"));
    try {
      const outsidePath = join(outsideDir, "transcript.jsonl");
      await writeFile(outsidePath, '{"type":"user","text":"secret stuff"}\n', "utf8");
      const id = await createFixtureIssue(fixture, { transcriptPath: outsidePath });

      const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "must never run" }));
      const outcome = await runTriageOnce(baseDeps(fixture, investigate));
      assert.deepEqual(outcome, { kind: "transcript-missing", id });
      assert.equal(count(), 0);

      const issue = await showIssue(fixture, id);
      assert.ok((issue.labels ?? []).includes("triage:transcript-missing"));
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  } finally {
    await fixture.cleanup();
  }
});

await test("transcript trust boundary: a directory (not a regular file) is treated as unsafe", async () => {
  const fixture = await createFixtureTracker();
  try {
    const dirPath = join(fixture.sessionsRoot, "not-a-file");
    await mkdir(dirPath, { recursive: true });
    const id = await createFixtureIssue(fixture, { transcriptPath: dirPath });

    const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "must never run" }));
    const outcome = await runTriageOnce(baseDeps(fixture, investigate));
    assert.deepEqual(outcome, { kind: "transcript-missing", id });
    assert.equal(count(), 0);
  } finally {
    await fixture.cleanup();
  }
});

await test("transcript trust boundary: a symlink escaping the trusted root is treated as unsafe", async () => {
  const fixture = await createFixtureTracker();
  try {
    const outsideDir = await mkdtemp(join(tmpdir(), "pi-triage-outside-"));
    try {
      const secretPath = join(outsideDir, "secret.jsonl");
      await writeFile(secretPath, '{"type":"user","text":"secret stuff"}\n', "utf8");
      const linkPath = join(fixture.sessionsRoot, "escape-link.jsonl");
      await symlink(secretPath, linkPath);
      const id = await createFixtureIssue(fixture, { transcriptPath: linkPath });

      const { investigate, count } = makeCountingInvestigator(async () => ({ ok: true, text: "must never run" }));
      const outcome = await runTriageOnce(baseDeps(fixture, investigate));
      assert.deepEqual(outcome, { kind: "transcript-missing", id });
      assert.equal(count(), 0);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  } finally {
    await fixture.cleanup();
  }
});

await test("transcript trust boundary: a file inside the trusted root is usable", async () => {
  const fixture = await createFixtureTracker();
  try {
    const insidePath = join(fixture.sessionsRoot, "ok-transcript.jsonl");
    await writeFile(insidePath, '{"type":"user","text":"hello"}\n', "utf8");
    assert.equal(await isTranscriptPathUsable(insidePath, fixture.sessionsRoot), true);
    assert.equal(await isTranscriptPathUsable(join(fixture.sessionsRoot, "missing.jsonl"), fixture.sessionsRoot), false);
  } finally {
    await fixture.cleanup();
  }
});

await test("readBoundedTranscript never loads more than the configured byte cap into memory, for files far larger than the cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-triage-bounded-read-"));
  try {
    const bigPath = join(dir, "huge.jsonl");
    const lineCount = 200_000;
    const chunks: string[] = [];
    for (let i = 0; i < lineCount; i++) chunks.push(`{"line":${i},"pad":"${"x".repeat(40)}"}`);
    const content = chunks.join("\n");
    await writeFile(bigPath, content, "utf8");
    const fileSize = (await stat(bigPath)).size;
    assert.ok(fileSize > 5_000_000, "fixture file must actually be large to be a meaningful test");

    const maxBytes = 20_000;
    const bounded = await readBoundedTranscript(bigPath, maxBytes);
    // Allow slack for the inserted "… truncated …" marker text itself.
    assert.ok(bounded.length <= maxBytes + 200, `bounded read grew unexpectedly large: ${bounded.length}`);
    assert.match(bounded, /^\{"line":0,/, "head of the file must be preserved");
    // Last line has no trailing newline, so the file (and the tail chunk) ends
    // with its `pad` field, not `line` — assert on the actual last-line marker.
    assert.match(bounded, new RegExp(`"line":${lineCount - 1},"pad"`), "tail of the file must be preserved");
    assert.ok(bounded.endsWith('"}'), "the read must end at the file's actual last byte");
    assert.match(bounded, /only the first\/last .* bytes were read from disk/);

    // Small-file path: entirely below the cap, read whole and verbatim.
    const smallPath = join(dir, "small.jsonl");
    await writeFile(smallPath, "line-1\nline-2\n", "utf8");
    const wholeSmall = await readBoundedTranscript(smallPath, maxBytes);
    assert.equal(wholeSmall, "line-1\nline-2\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── makeRealInvestigator: JSON-mode subprocess wiring ────────────────────

/**
 * Writes a controllable fake `pi` executable that: (1) always captures its
 * full argv to `capturePath` for exact-argv assertions, and (2) emits a
 * `--mode json`-shaped JSONL stdout stream (session header + a
 * `message_end` assistant event) whose content is controlled by the
 * `FAKE_PI_MODE` / `FAKE_PI_STOP_REASON` / `FAKE_PI_ERROR_MESSAGE` /
 * `FAKE_PI_TEXT` / `FAKE_PI_EXIT_CODE` env vars, so every JSONL-parsing/
 * classification branch in `makeRealInvestigator` can be driven without a
 * real model call. When invoked with `--session-dir`/`--session-id`, it also
 * writes a same-shaped, real (empty-bodied) session file into that
 * directory under Pi's own naming convention, so session-file resolution
 * can be exercised end-to-end.
 */
async function writeFakePiExecutable(binDir: string): Promise<string> {
  const fakePiPath = join(binDir, "pi");
  await writeFile(
    fakePiPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "const path = require('path');",
      "const args = process.argv.slice(2);",
      "fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(args));",
      "function argValue(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }",
      "const sessionDir = argValue('--session-dir');",
      "const sessionId = argValue('--session-id');",
      "function writeSessionFile() {",
      "  if (!sessionDir || !sessionId) return;",
      "  if (process.env.FAKE_PI_SKIP_SESSION_FILE === '1') return;",
      "  fs.mkdirSync(sessionDir, { recursive: true });",
      "  const ts = new Date().toISOString().replace(/[:.]/g, '-');",
      "  const headerId = process.env.FAKE_PI_SESSION_FILE_ID || sessionId;",
      "  const header = JSON.stringify({ type: 'session', version: 2, id: headerId, timestamp: new Date().toISOString(), cwd: process.cwd() });",
      "  fs.writeFileSync(path.join(sessionDir, `${ts}_${sessionId}.jsonl`), header + '\\n');",
      "}",
      "function headerLine() { return JSON.stringify({ type: 'session', version: 2, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }); }",
      "function messageEndLine(overrides) { return JSON.stringify({ type: 'message_end', message: Object.assign({ role: 'assistant', content: [{ type: 'text', text: process.env.FAKE_PI_TEXT ?? 'FAKE FINDINGS TEXT' }], stopReason: process.env.FAKE_PI_STOP_REASON || 'stop', errorMessage: process.env.FAKE_PI_ERROR_MESSAGE }, overrides) }); }",
      "const mode = process.env.FAKE_PI_MODE || 'success';",
      "if (mode === 'fail-exit') {",
      "  process.stderr.write('synthetic investigator failure\\n');",
      "  process.exit(Number(process.env.FAKE_PI_EXIT_CODE || '3'));",
      "} else if (mode === 'no-assistant') {",
      "  writeSessionFile();",
      "  process.stdout.write(headerLine() + '\\n');",
      "  process.exit(0);",
      "} else if (mode === 'malformed-only') {",
      "  process.stdout.write('not valid json at all\\n');",
      "  process.exit(0);",
      "} else {",
      "  writeSessionFile();",
      "  process.stdout.write(headerLine() + '\\n');",
      "  process.stdout.write(messageEndLine({}) + '\\n');",
      "  process.exit(0);",
      "}",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakePiPath;
}

await test("makeRealInvestigator: exact subprocess argv — no --no-session, uses --mode json, an explicit --session-id, and the dedicated --session-dir", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "pi-triage-fakebin-"));
  const sessionsDir = join(binDir, "investigator-sessions");
  try {
    const capturePath = join(binDir, "captured-argv.json");
    const fakePiPath = await writeFakePiExecutable(binDir);
    const execWithFakePi: ExecFn = (command, args, options) =>
      realExec({ PATH: `${binDir}:${process.env.PATH ?? ""}`, CAPTURE_PATH: capturePath })(command, args, options);

    const investigator = makeRealInvestigator(execWithFakePi, fakePiPath, sessionsDir, 200);
    const ok = await investigator("the actual prompt text", {
      cwd: binDir,
      timeoutMs: 10_000,
      model: "prov/model-x",
      runId: "run-abc-123",
      attempt: 2,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.text, "FAKE FINDINGS TEXT");

    const argv = JSON.parse(await readFile(capturePath, "utf8")) as string[];
    assert.deepEqual(argv, [
      "--mode",
      "json",
      "--session-dir",
      sessionsDir,
      "--session-id",
      "pi-triage-run-abc-123-a2",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--offline",
      "--no-tools",
      "--model",
      "prov/model-x",
      "the actual prompt text",
    ]);
    assert.ok(!argv.includes("--no-session"), "the real investigator must never pass --no-session any more");
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

await test("makeRealInvestigator: success path parses JSONL, extracts final assistant text, and populates bounded audit data", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "pi-triage-fakebin-"));
  const sessionsDir = join(binDir, "investigator-sessions");
  try {
    const capturePath = join(binDir, "captured-argv.json");
    const fakePiPath = await writeFakePiExecutable(binDir);
    const execWithFakePi: ExecFn = (command, args, options) =>
      realExec({ PATH: `${binDir}:${process.env.PATH ?? ""}`, CAPTURE_PATH: capturePath, FAKE_PI_TEXT: "Root cause: X." })(
        command,
        args,
        options,
      );
    const investigator = makeRealInvestigator(execWithFakePi, fakePiPath, sessionsDir, 200);
    const result = await investigator("prompt", { cwd: binDir, timeoutMs: 10_000, runId: "run-1", attempt: 1 });

    assert.equal(result.ok, true);
    assert.equal(result.text, "Root cause: X.");
    assert.ok(result.audit, "a successful real investigator call must always populate audit data");
    assert.equal(result.audit!.sessionId, "pi-triage-run-1-a1");
    assert.match(result.audit!.sessionFile ?? "", /pi-triage-run-1-a1\.jsonl$/);
    assert.equal(result.audit!.stopReason, "stop");
    assert.equal(result.audit!.exitCode, 0);
    assert.equal(result.audit!.killed, false);
    assert.ok(result.audit!.stdoutBytes > 0);
    assert.match(result.audit!.stdoutSha256, /^[a-f0-9]{64}$/);
    assert.match(result.audit!.stderrSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.audit!.malformedLineCount, 0);
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

await test("makeRealInvestigator: a nonzero exit is an investigator failure regardless of any JSONL content, and the audit stays bounded", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "pi-triage-fakebin-"));
  const sessionsDir = join(binDir, "investigator-sessions");
  try {
    const capturePath = join(binDir, "captured-argv.json");
    const fakePiPath = await writeFakePiExecutable(binDir);
    const execWithFailingFakePi: ExecFn = (command, args, options) =>
      realExec({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CAPTURE_PATH: capturePath,
        FAKE_PI_MODE: "fail-exit",
      })(command, args, options);
    const investigator = makeRealInvestigator(execWithFailingFakePi, fakePiPath, sessionsDir, 200);
    const failed = await investigator("another prompt", { cwd: binDir, timeoutMs: 10_000, runId: "run-2", attempt: 1 });

    assert.equal(failed.ok, false);
    assert.match(failed.error ?? "", /pi --mode json \(investigator\)/);
    assert.match(failed.error ?? "", /synthetic investigator failure/);
    assert.ok(failed.audit, "a failed real investigator call must still populate audit data");
    assert.equal(failed.audit!.exitCode, 3);
    assert.equal(failed.audit!.killed, false);
    assert.ok(failed.audit!.stdoutExcerpt.length <= 2_100, "the audit stdout excerpt must stay bounded");
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

await test("makeRealInvestigator: stopReason error/aborted is classified as failure even though the process itself exits 0", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "pi-triage-fakebin-"));
  const sessionsDir = join(binDir, "investigator-sessions");
  try {
    const capturePath = join(binDir, "captured-argv.json");
    const fakePiPath = await writeFakePiExecutable(binDir);
    const execWithErrorStopReason: ExecFn = (command, args, options) =>
      realExec({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CAPTURE_PATH: capturePath,
        FAKE_PI_STOP_REASON: "error",
        FAKE_PI_ERROR_MESSAGE: "model unavailable",
      })(command, args, options);
    const investigator = makeRealInvestigator(execWithErrorStopReason, fakePiPath, sessionsDir, 200);
    const result = await investigator("prompt", { cwd: binDir, timeoutMs: 10_000, runId: "run-3", attempt: 1 });

    assert.equal(result.ok, false, "a stopReason of error must be a failure even though the pi process exits 0");
    assert.equal(result.error, "model unavailable");
    assert.equal(result.audit?.stopReason, "error");
    assert.equal(result.audit?.exitCode, 0);

    const execWithAborted: ExecFn = (command, args, options) =>
      realExec({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CAPTURE_PATH: capturePath,
        FAKE_PI_STOP_REASON: "aborted",
      })(command, args, options);
    const abortedInvestigator = makeRealInvestigator(execWithAborted, fakePiPath, sessionsDir, 200);
    const abortedResult = await abortedInvestigator("prompt", { cwd: binDir, timeoutMs: 10_000, runId: "run-4", attempt: 1 });
    assert.equal(abortedResult.ok, false);
    assert.equal(abortedResult.audit?.stopReason, "aborted");
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

await test("makeRealInvestigator: missing or malformed terminal assistant data on a 0 exit is a failure, not a silent success", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "pi-triage-fakebin-"));
  const sessionsDir = join(binDir, "investigator-sessions");
  try {
    const capturePath = join(binDir, "captured-argv.json");
    const fakePiPath = await writeFakePiExecutable(binDir);
    const execNoAssistant: ExecFn = (command, args, options) =>
      realExec({ PATH: `${binDir}:${process.env.PATH ?? ""}`, CAPTURE_PATH: capturePath, FAKE_PI_MODE: "no-assistant" })(
        command,
        args,
        options,
      );
    const investigator = makeRealInvestigator(execNoAssistant, fakePiPath, sessionsDir, 200);
    const result = await investigator("prompt", { cwd: binDir, timeoutMs: 10_000, runId: "run-5", attempt: 1 });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /no parseable terminal assistant message/);

    const execMalformedOnly: ExecFn = (command, args, options) =>
      realExec({ PATH: `${binDir}:${process.env.PATH ?? ""}`, CAPTURE_PATH: capturePath, FAKE_PI_MODE: "malformed-only" })(
        command,
        args,
        options,
      );
    const malformedInvestigator = makeRealInvestigator(execMalformedOnly, fakePiPath, sessionsDir, 200);
    const malformedResult = await malformedInvestigator("prompt", { cwd: binDir, timeoutMs: 10_000, runId: "run-6", attempt: 1 });
    assert.equal(malformedResult.ok, false);
    assert.equal(malformedResult.audit?.malformedLineCount, 1);
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

await test("makeRealInvestigator: a discovered session file whose own header id does not match the explicitly requested --session-id is a failure, never accepted as success", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "pi-triage-fakebin-"));
  const sessionsDir = join(binDir, "investigator-sessions");
  try {
    const capturePath = join(binDir, "captured-argv.json");
    const fakePiPath = await writeFakePiExecutable(binDir);
    // The fake pi process itself exits 0, writes a perfectly well-formed
    // `message_end` assistant event to stdout, AND writes a session file at
    // the exact expected filename — but that file's own header carries a
    // *different* session id than the one this call explicitly requested
    // via --session-id (simulating e.g. a Pi bug, a corrupted write, or a
    // race with another process). This must never be silently accepted as
    // success purely because the filename matched.
    const execMismatchedHeader: ExecFn = (command, args, options) =>
      realExec({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CAPTURE_PATH: capturePath,
        FAKE_PI_SESSION_FILE_ID: "some-other-unrelated-session-id",
      })(command, args, options);
    const investigator = makeRealInvestigator(execMismatchedHeader, fakePiPath, sessionsDir, 200);
    const result = await investigator("prompt", { cwd: binDir, timeoutMs: 10_000, runId: "run-mismatch", attempt: 1 });

    assert.equal(result.ok, false, "a session-file attribution mismatch must never be accepted as success");
    assert.match(result.error ?? "", /session file attribution mismatch/);
    assert.match(result.error ?? "", /pi-triage-run-mismatch-a1/, "the error must name the id that was actually requested");
    assert.ok(result.audit, "audit data must still be populated even on an attribution-mismatch failure");
    assert.equal(result.audit!.exitCode, 0, "the underlying pi process itself still exited 0");
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

await test("makeRealInvestigator: a pre-existing, suffix-matching stale file left behind by an earlier run is not blindly trusted — its header must still match, or the call fails", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "pi-triage-fakebin-"));
  const sessionsDir = join(binDir, "investigator-sessions");
  try {
    const capturePath = join(binDir, "captured-argv.json");
    const fakePiPath = await writeFakePiExecutable(binDir);
    const runId = "run-stale";
    const attempt = 1;
    // Pre-seed a stale file that matches the *filename suffix* this call
    // will look for, but carries no parseable session header at all (e.g.
    // truncated/corrupted, or simply empty) — as if left behind by an
    // earlier crashed attempt that reused the same run id/attempt. The fake
    // pi process for *this* call is configured to skip writing its own
    // session file (FAKE_PI_SKIP_SESSION_FILE=1), so the stale file is the
    // *only* candidate `resolveInvestigatorSessionFile`'s suffix match can
    // possibly find.
    await mkdir(sessionsDir, { recursive: true });
    const expectedSessionId = "pi-triage-run-stale-a1";
    await writeFile(join(sessionsDir, `2020-01-01T00-00-00-000Z_${expectedSessionId}.jsonl`), "", "utf8");

    const execSkipsOwnSessionFile: ExecFn = (command, args, options) =>
      realExec({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CAPTURE_PATH: capturePath,
        FAKE_PI_SKIP_SESSION_FILE: "1",
      })(command, args, options);
    const investigator = makeRealInvestigator(execSkipsOwnSessionFile, fakePiPath, sessionsDir, 200);
    const result = await investigator("prompt", { cwd: binDir, timeoutMs: 10_000, runId, attempt });

    assert.equal(result.ok, false, "an unparseable pre-existing stale file must never be blindly trusted as this attempt's session");
    assert.match(result.error ?? "", /session file attribution mismatch/);
    assert.match(result.audit?.sessionFile ?? "", /2020-01-01T00-00-00-000Z_pi-triage-run-stale-a1\.jsonl$/);
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

await test("BLOCKER regression: a bad/non-session first line in the discovered file followed by a matching session object on a later line must fail, never be accepted by scanning past it", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "pi-triage-fakebin-"));
  const sessionsDir = join(binDir, "investigator-sessions");
  try {
    const capturePath = join(binDir, "captured-argv.json");
    const fakePiPath = await writeFakePiExecutable(binDir);
    const runId = "run-badfirstline";
    const attempt = 1;
    const expectedSessionId = `pi-triage-${runId}-a${attempt}`;
    await mkdir(sessionsDir, { recursive: true });
    // Line 1 is garbage; line 2 is a *correctly matching* session header.
    // A parser that scans every line for the first session-shaped record
    // (like `parseInvestigatorJsonl`) would incorrectly accept line 2. This
    // must fail instead: only the first line is ever a legitimate Pi
    // session header, and this file's first line isn't one.
    const maliciousContent = [
      "this is not a session header at all",
      JSON.stringify({ type: "session", version: 2, id: expectedSessionId, timestamp: new Date().toISOString(), cwd: "/tmp" }),
    ].join("\n");
    await writeFile(join(sessionsDir, `2020-01-01T00-00-00-000Z_${expectedSessionId}.jsonl`), maliciousContent, "utf8");

    const execSkipsOwnSessionFile: ExecFn = (command, args, options) =>
      realExec({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CAPTURE_PATH: capturePath,
        FAKE_PI_SKIP_SESSION_FILE: "1",
      })(command, args, options);
    const investigator = makeRealInvestigator(execSkipsOwnSessionFile, fakePiPath, sessionsDir, 200);
    const result = await investigator("prompt", { cwd: binDir, timeoutMs: 10_000, runId, attempt });

    assert.equal(
      result.ok,
      false,
      "a bad first line must never let a later, coincidentally-matching session object be accepted as the header",
    );
    assert.match(result.error ?? "", /session file attribution mismatch/);
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

await test("makeRealInvestigator: a valid session header on line 1 followed by further legitimate session content still succeeds (preserves valid-session success)", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "pi-triage-fakebin-"));
  const sessionsDir = join(binDir, "investigator-sessions");
  try {
    const capturePath = join(binDir, "captured-argv.json");
    const fakePiPath = await writeFakePiExecutable(binDir);
    const runId = "run-goodmultiline";
    const attempt = 1;
    const expectedSessionId = `pi-triage-${runId}-a${attempt}`;
    await mkdir(sessionsDir, { recursive: true });
    // A realistic persisted Pi session file: a valid header on line 1,
    // followed by further legitimate JSONL events on later lines (exactly
    // what a real session file always looks like) — this must still verify
    // successfully; only the *first* line needs to be a valid, matching
    // header, and content after it is never a reason to reject it.
    const realisticContent = [
      JSON.stringify({ type: "session", version: 2, id: expectedSessionId, timestamp: new Date().toISOString(), cwd: "/tmp" }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" } }),
    ].join("\n");
    await writeFile(join(sessionsDir, `2020-01-01T00-00-00-000Z_${expectedSessionId}.jsonl`), realisticContent, "utf8");

    const execSkipsOwnSessionFile: ExecFn = (command, args, options) =>
      realExec({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CAPTURE_PATH: capturePath,
        FAKE_PI_SKIP_SESSION_FILE: "1",
      })(command, args, options);
    const investigator = makeRealInvestigator(execSkipsOwnSessionFile, fakePiPath, sessionsDir, 200);
    const result = await investigator("prompt", { cwd: binDir, timeoutMs: 10_000, runId, attempt });

    assert.equal(result.ok, true, "a valid first-line header followed by further legitimate content must still succeed");
    assert.match(result.audit?.sessionFile ?? "", /2020-01-01T00-00-00-000Z_pi-triage-run-goodmultiline-a1\.jsonl$/);
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

await test("BLOCKER regression: an exit-0 result with a well-formed assistant message but NO discoverable persisted session file must fail, never succeed with sessionFile:null", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "pi-triage-fakebin-"));
  const sessionsDir = join(binDir, "investigator-sessions");
  try {
    const capturePath = join(binDir, "captured-argv.json");
    const fakePiPath = await writeFakePiExecutable(binDir);
    // The fake pi process exits 0 and writes a perfectly well-formed
    // `message_end` assistant event to stdout, but is configured to skip
    // writing its own session file, and no stale file happens to exist
    // either — so there is genuinely nothing to discover. Per the
    // strengthened persistence contract, this must fail rather than be
    // accepted as a success with `sessionFile: null`.
    const execNoSessionFileAtAll: ExecFn = (command, args, options) =>
      realExec({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CAPTURE_PATH: capturePath,
        FAKE_PI_SKIP_SESSION_FILE: "1",
      })(command, args, options);
    const investigator = makeRealInvestigator(execNoSessionFileAtAll, fakePiPath, sessionsDir, 200);
    const result = await investigator("prompt", { cwd: binDir, timeoutMs: 10_000, runId: "run-nofile", attempt: 1 });

    assert.equal(result.ok, false, "an exit-0 result with no discoverable session file must never succeed");
    assert.match(result.error ?? "", /no persisted session file could be discovered/);
    assert.equal(result.audit?.sessionFile ?? null, null);
    assert.equal(result.audit?.exitCode, 0);
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

await test("pruneInvestigatorSessions: keeps only the newest N session files under the dedicated investigator directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-triage-retention-"));
  try {
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const name = `2026-01-0${i + 1}T00-00-00-000Z_sess-${i}.jsonl`;
      names.push(name);
      await writeFile(join(dir, name), "", "utf8");
    }
    // A non-session file must never be touched by retention pruning.
    await writeFile(join(dir, "README.txt"), "keep me", "utf8");

    const removed = await pruneInvestigatorSessions(dir, 2);
    assert.deepEqual(removed, names.slice(0, 3));

    const remaining = (await readFile(join(dir, "README.txt"), "utf8")).trim();
    assert.equal(remaining, "keep me");

    const survivors = (await readdir(dir)).sort();
    assert.deepEqual(survivors, ["2026-01-04T00-00-00-000Z_sess-3.jsonl", "2026-01-05T00-00-00-000Z_sess-4.jsonl", "README.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test("pruneInvestigatorSessions is a safe no-op for a missing directory", async () => {
  const removed = await pruneInvestigatorSessions(join(tmpdir(), "pi-triage-does-not-exist-xyz"), 200);
  assert.deepEqual(removed, []);
});

await test("PartialTriageError surfaces the issue id for deterministic recovery messaging", async () => {
  const fixture = await createFixtureTracker();
  try {
    const err = new PartialTriageError("pir-1", "git commit failed with exit code 1: boom");
    assert.equal(err.id, "pir-1");
    assert.match(err.message, /git commit failed/);
  } finally {
    await fixture.cleanup();
  }
});

await test("pause/resume flag helpers round-trip without touching the tracker", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-triage-agentdir-"));
  try {
    assert.equal(await isPausedFlagSet(agentDir), false);
    await setPausedFlag(agentDir, true);
    assert.equal(await isPausedFlagSet(agentDir), true);
    await stat(pausedFlagPath(agentDir)); // does not throw
    await setPausedFlag(agentDir, false);
    assert.equal(await isPausedFlagSet(agentDir), false);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

// ─── pi-tick-visible exit-1 contract (isolated harness, no real pi/pi-tick) ───

/**
 * Spawns a tiny, isolated Node/Bun script that exercises the *real*
 * `isHeadlessExitOnFailureEnabled` / `shouldForceHeadlessExit` /
 * `formatHeadlessFailureStderrLine` pure functions from triage-core.ts —
 * i.e. the exact decision logic `index.ts`'s `maybeForceHeadlessExit` uses
 * — in a real, separate OS process, then applies the same synchronous
 * `writeSync(2, ...)` + `process.exit(1)` pattern `index.ts` uses. This
 * verifies the actual pi-tick-visible contract (nonzero process exit code,
 * with the bounded `Error:` line fully present on stderr) at a real process
 * boundary, without spawning a real `pi` binary, touching Beads/Git, or
 * mutating the real scheduled pi-tick job in any way.
 */
async function runHeadlessExitHarness(env: {
  HARNESS_MODE: string;
  HARNESS_BENIGN?: string;
  PI_TRIAGE_HEADLESS_EXIT_ON_FAILURE?: string;
}): Promise<ExecResult> {
  const scriptPath = join(REPORT_DIR, "triage-core.ts");
  const harnessSource = [
    `import { isHeadlessExitOnFailureEnabled, shouldForceHeadlessExit, formatHeadlessFailureStderrLine } from ${JSON.stringify(scriptPath)};`,
    "import { writeSync } from 'node:fs';",
    "const mode = process.env.HARNESS_MODE;",
    "const outcomeIsBenign = process.env.HARNESS_BENIGN === '1';",
    "const killSwitchEnabled = isHeadlessExitOnFailureEnabled(process.env);",
    "if (shouldForceHeadlessExit({ mode, outcomeIsBenign, killSwitchEnabled })) {",
    "  writeSync(2, formatHeadlessFailureStderrLine('simulated non-benign /triage-report outcome for the isolated harness test'));",
    "  process.exit(1);",
    "}",
    "console.log('no-exit-forced');",
    "process.exit(0);",
    "",
  ].join("\n");

  const dir = await mkdtemp(join(tmpdir(), "pi-triage-headless-harness-"));
  try {
    const harnessPath = join(dir, "harness.mjs");
    await writeFile(harnessPath, harnessSource, "utf8");
    return await realExec(env)(process.execPath, [harnessPath], { timeout: 10_000 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await test("pi-tick-visible exit-1 contract: a non-benign outcome outside TUI forces exit 1 with one bounded, synchronous Error: line on stderr", async () => {
  const res = await runHeadlessExitHarness({ HARNESS_MODE: "rpc", HARNESS_BENIGN: "0" });
  assert.equal(res.code, 1, `expected exit code 1, got ${res.code}; stderr: ${res.stderr}`);
  assert.ok(res.stderr.startsWith("Error:"), `expected stderr to start with "Error:", got: ${res.stderr}`);
  assert.equal(res.stderr.match(/\n/g)?.length, 1, "expected exactly one bounded line on stderr");
});

await test("pi-tick-visible exit-1 contract: an interactive TUI session is never forced to exit, even on a non-benign outcome", async () => {
  const res = await runHeadlessExitHarness({ HARNESS_MODE: "tui", HARNESS_BENIGN: "0" });
  assert.equal(res.code, 0, `TUI mode must never be forced to exit nonzero by this policy; stderr: ${res.stderr}`);
  assert.equal(res.stderr.trim(), "");
  assert.match(res.stdout, /no-exit-forced/);
});

await test("pi-tick-visible exit-1 contract: a benign outcome outside TUI never forces an exit", async () => {
  const res = await runHeadlessExitHarness({ HARNESS_MODE: "rpc", HARNESS_BENIGN: "1" });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /no-exit-forced/);
});

await test("pi-tick-visible exit-1 contract: the kill switch, once explicitly disabled, suppresses the forced exit even on a non-benign outcome outside TUI", async () => {
  const res = await runHeadlessExitHarness({
    HARNESS_MODE: "rpc",
    HARNESS_BENIGN: "0",
    PI_TRIAGE_HEADLESS_EXIT_ON_FAILURE: "0",
  });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /no-exit-forced/);
});

await test("pi-tick-visible exit-1 contract: print and json modes are also outside TUI and are forced to exit on a non-benign outcome", async () => {
  for (const mode of ["print", "json"]) {
    const res = await runHeadlessExitHarness({ HARNESS_MODE: mode, HARNESS_BENIGN: "0" });
    assert.equal(res.code, 1, `mode "${mode}" must force exit 1 on a non-benign outcome`);
  }
});

// ─── index.ts wiring: unknown /triage-report subcommands must also be non-benign ───

/**
 * `index.ts`'s actual command handler cannot be exercised through this
 * package's existing test seams (it depends on Pi's real, unmockable
 * `ExtensionAPI`/`ExtensionCommandContext`; nothing in this codebase unit-
 * tests `index.ts` directly — see the `pi-tick-visible exit-1 contract`
 * tests above, which instead test the real, shared, already-imported pure
 * decision functions in isolation). The "smallest feasible" regression
 * signal for the specific requirement that the unknown-subcommand branch
 * must call the existing headless failure policy is therefore a direct,
 * narrow source check: confirm that branch's `notify(...)` call is
 * immediately followed by a `maybeForceHeadlessExit(...)` call, before its
 * `return` — so a future refactor that accidentally drops that call is
 * caught here rather than silently regressing pi-tick's ability to detect a
 * misconfigured/typo'd scheduled prompt.
 */
await test("index.ts wiring: an unknown /triage-report subcommand notifies, then calls the headless failure policy so a scheduled typo is visible as a nonzero exit outside TUI", async () => {
  const indexSource = await readFile(join(REPORT_DIR, "index.ts"), "utf8");
  const marker = "Unknown /triage-report subcommand:";
  const markerIndex = indexSource.indexOf(marker);
  assert.ok(markerIndex >= 0, "expected the unknown-subcommand notification string to exist in index.ts");

  const window = indexSource.slice(markerIndex, markerIndex + 700);
  const notifyIndex = window.indexOf("notify(");
  const forceExitIndex = window.indexOf("maybeForceHeadlessExit(");
  const returnIndex = window.indexOf("return;");
  assert.ok(notifyIndex >= 0, "expected a notify(...) call in the unknown-subcommand branch");
  assert.ok(
    forceExitIndex >= 0,
    "the unknown-subcommand branch must call maybeForceHeadlessExit(...) so a scheduled typo is visible as a nonzero exit outside TUI",
  );
  assert.ok(returnIndex >= 0, "expected a return; statement ending the unknown-subcommand branch");
  assert.ok(notifyIndex < forceExitIndex, "notify(...) must run before maybeForceHeadlessExit(...) (notify first, then the failure policy)");
  assert.ok(forceExitIndex < returnIndex, "maybeForceHeadlessExit(...) must run before the branch returns");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
