import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIssueDescription,
  countSessionEntries,
  hardenedCommitArgs,
  parseCreatedBead,
  parseReportInput,
  restoreBenignEmptyExportDeletion,
  withTrackerLock,
  type ExecLike,
  type ReportMetadata,
} from "./report-core.ts";

function realExec(): ExecLike {
  return (command, args, options) =>
    new Promise((resolve) => {
      execFile(command, args, { cwd: options?.cwd, timeout: options?.timeout }, (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? (error as unknown as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code });
      });
    });
}

async function initGitRepo(dir: string): Promise<ExecLike> {
  const exec = realExec();
  const run = async (args: string[]) => {
    const res = await exec("git", args, { cwd: dir });
    if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    return res;
  };
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "test@example.invalid"]);
  await run(["config", "user.name", "Test"]);
  return exec;
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

await test("parses first non-empty line as title", () => {
  assert.deepEqual(parseReportInput("\n  Broken reload  \nSteps\nMore"), {
    title: "Broken reload",
    description: "Steps\nMore",
  });
});

await test("normalizes CRLF and permits title-only reports", () => {
  assert.deepEqual(parseReportInput("A title\r\n\r\n"), {
    title: "A title",
    description: "",
  });
});

await test("rejects blank reports", () => {
  assert.equal(parseReportInput(" \n\t\n"), null);
});

await test("counts active branch roles separately from total entries", () => {
  const branch = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "toolResult" } },
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "bashExecution" } },
    { type: "custom_message" },
    { type: "compaction" },
  ];
  const all = [...branch, { type: "message", message: { role: "user" } }];
  assert.deepEqual(countSessionEntries(all, branch), {
    activeBranchEntries: 7,
    totalSessionEntries: 8,
    userPrompts: 1,
    assistantTurns: 2,
    toolResults: 1,
    bashExecutions: 1,
    customMessages: 1,
  });
});

const metadata: ReportMetadata = {
  schemaVersion: 1,
  source: "pi-report",
  reportKey: "session-1:2026-07-17T10:00:00.000Z",
  reportTimestamp: "2026-07-17T10:00:00.000Z",
  session: {
    id: "session-1",
    name: "Test session",
    startedAt: "2026-07-17T09:00:00.000Z",
    cwd: "/tmp/project",
    transcriptFile: "/tmp/session.jsonl",
    persisted: true,
    leafId: "abc12345",
    parentSession: null,
    counts: {
      activeBranchEntries: 3,
      totalSessionEntries: 5,
      userPrompts: 1,
      assistantTurns: 1,
      toolResults: 1,
      bashExecutions: 0,
      customMessages: 0,
    },
  },
  runtime: {
    piVersion: "0.80.3",
    nodeVersion: "v25.0.0",
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.0.0",
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    activeTools: ["read", "bash"],
    extensionSources: ["/tmp/report/index.ts"],
  },
  git: {
    root: "/tmp/project",
    branch: "main",
    head: "0123456789abcdef",
    dirty: true,
  },
};

await test("builds deterministic human-readable issue body", () => {
  const body = buildIssueDescription(
    { title: "Failure", description: "Steps to reproduce" },
    metadata,
  );
  assert.match(body, /## User report\n\nSteps to reproduce/);
  assert.match(body, /Session ID: `session-1`/);
  assert.match(body, /Assistant turns: 1/);
  assert.match(body, /Model: `provider\/model`/);
  assert.match(body, /Dirty: yes/);
  assert.match(body, /No LLM was used\./);
});

await test("uses a fixed placeholder for title-only reports", () => {
  const body = buildIssueDescription({ title: "Failure", description: "" }, metadata);
  assert.match(body, /_No additional details provided\._/);
});

await test("builds a hook-suppressed, path-limited commit command", () => {
  assert.deepEqual(hardenedCommitArgs("/tmp/empty-hooks", "pir-abc"), [
    "-c",
    "core.hooksPath=/tmp/empty-hooks",
    "commit",
    "--no-verify",
    "-m",
    "report: pir-abc",
    "--",
    ".beads/issues.jsonl",
  ]);
});

await test("parses bd JSON output and tolerates wrapper noise", () => {
  const expected = { id: "pir-abc", title: "Failure" };
  assert.deepEqual(parseCreatedBead('{"id":"pir-abc","title":"Failure"}\n'), expected);
  assert.deepEqual(
    parseCreatedBead('informational line\n{"issue":{"id":"pir-abc","title":"Failure"}}\n'),
    expected,
  );
  assert.throws(() => parseCreatedBead("not-json"), /parseable issue ID/);
  assert.throws(() => parseCreatedBead("{}"), /parseable issue ID/);
});

await test("serializes tracker operations with a lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-report-lock-test-"));
  const events: string[] = [];
  try {
    const first = withTrackerLock(directory, async () => {
      events.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 150));
      events.push("first-end");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = withTrackerLock(directory, async () => {
      events.push("second-start");
      events.push("second-end");
    });
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("stale-owner lock reclaim never deletes a live replacement owner's lock (ownership token)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-report-lock-race-test-"));
  const events: string[] = [];
  const timing = { maxAgeMs: 20, waitMs: 5000, retryMs: 5 };
  try {
    // `a` holds the lock past `maxAgeMs` while still legitimately running —
    // simulating an operation slow enough to look "stuck" by the staleness
    // heuristic even though it is not.
    const a = withTrackerLock(
      directory,
      async () => {
        events.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 60));
        events.push("a-end");
      },
      timing,
    );

    // Give `a`'s lock time to exist and to cross maxAgeMs so `b` reclaims it
    // as stale while `a` is still running.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const b = withTrackerLock(
      directory,
      async () => {
        events.push("b-start");
        await new Promise((resolve) => setTimeout(resolve, 150));
        events.push("b-end");
      },
      timing,
    );

    // By now `a` has finished and run its cleanup (~t=90), but `b` (reclaimed
    // at ~t=30, running 150ms) is still active. The buggy unconditional
    // `rm(lockPath)` in `a`'s cleanup would delete `b`'s live lock file here;
    // the fixed, token-checked cleanup must not.
    await a;
    const lockPath = join(directory, ".pi-report.lock");
    const stillThere = await readFile(lockPath, "utf8").then(
      () => true,
      () => false,
    );
    assert.equal(stillThere, true, "a's cleanup must not delete b's live replacement lock");

    await b;
    const goneAfterB = await readFile(lockPath, "utf8").then(
      () => false,
      () => true,
    );
    assert.equal(goneAfterB, true, "b must still clean up its own lock normally");

    assert.deepEqual(events, ["a-start", "b-start", "a-end", "b-end"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("restoreBenignEmptyExportDeletion: heals a deleted-but-was-tracked-empty issues.jsonl", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-report-export-heal-test-"));
  try {
    const exec = await initGitRepo(directory);
    const beadsDir = join(directory, ".beads");
    await import("node:fs/promises").then((fs) => fs.mkdir(beadsDir, { recursive: true }));
    await writeFile(join(beadsDir, "issues.jsonl"), "", "utf8");
    await exec("git", ["add", "-f", ".beads/issues.jsonl"], { cwd: directory });
    await exec("git", ["commit", "-q", "-m", "init"], { cwd: directory });

    // Already clean: no-op, returns true.
    assert.equal(await restoreBenignEmptyExportDeletion(exec, directory), true);

    // Simulate the Beads 1.0 quirk: the tracked (empty) file disappears.
    await rm(join(beadsDir, "issues.jsonl"), { force: true });
    const dirtyStatus = await exec("git", ["status", "--porcelain", "--", ".beads/issues.jsonl"], {
      cwd: directory,
    });
    assert.match(dirtyStatus.stdout.trim(), /^D? ?D \.beads\/issues\.jsonl$|^D \.beads\/issues\.jsonl$/);

    const healed = await restoreBenignEmptyExportDeletion(exec, directory);
    assert.equal(healed, true);

    const cleanStatus = await exec("git", ["status", "--porcelain", "--", ".beads/issues.jsonl"], {
      cwd: directory,
    });
    assert.equal(cleanStatus.stdout.trim(), "");
    const restoredContent = await readFile(join(beadsDir, "issues.jsonl"), "utf8");
    assert.equal(restoredContent, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("restoreBenignEmptyExportDeletion: refuses to touch a deleted NON-empty tracked file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-report-export-heal-nonempty-"));
  try {
    const exec = await initGitRepo(directory);
    const beadsDir = join(directory, ".beads");
    await import("node:fs/promises").then((fs) => fs.mkdir(beadsDir, { recursive: true }));
    await writeFile(join(beadsDir, "issues.jsonl"), '{"id":"real-issue"}\n', "utf8");
    await exec("git", ["add", "-f", ".beads/issues.jsonl"], { cwd: directory });
    await exec("git", ["commit", "-q", "-m", "init"], { cwd: directory });

    await rm(join(beadsDir, "issues.jsonl"), { force: true });
    const healed = await restoreBenignEmptyExportDeletion(exec, directory);
    assert.equal(healed, false, "must never silently restore a deletion of real, non-empty tracker content");

    const status = await exec("git", ["status", "--porcelain", "--", ".beads/issues.jsonl"], { cwd: directory });
    assert.notEqual(status.stdout.trim(), "", "the deletion must remain visible as real dirt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("restoreBenignEmptyExportDeletion: leaves unrelated dirt alone and reports it as not-clean", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-report-export-heal-unrelated-"));
  try {
    const exec = await initGitRepo(directory);
    const beadsDir = join(directory, ".beads");
    await import("node:fs/promises").then((fs) => fs.mkdir(beadsDir, { recursive: true }));
    await writeFile(join(beadsDir, "issues.jsonl"), "", "utf8");
    await exec("git", ["add", "-f", ".beads/issues.jsonl"], { cwd: directory });
    await exec("git", ["commit", "-q", "-m", "init"], { cwd: directory });

    await writeFile(join(directory, "unrelated.txt"), "dirtied\n", "utf8");
    const healed = await restoreBenignEmptyExportDeletion(exec, directory);
    // Unrelated dirt is outside the `-- .beads/issues.jsonl` pathspec, so the
    // function reports clean for *that file* specifically...
    assert.equal(healed, true);
    // ...but a caller's broader `git status --porcelain` (no pathspec) must
    // still see the unrelated file, proving this helper never masks real dirt
    // elsewhere in the tree.
    const broadStatus = await exec("git", ["status", "--porcelain"], { cwd: directory });
    assert.match(broadStatus.stdout, /unrelated\.txt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
