import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ReportCounts {
  activeBranchEntries: number;
  totalSessionEntries: number;
  userPrompts: number;
  assistantTurns: number;
  toolResults: number;
  bashExecutions: number;
  customMessages: number;
}

export interface ReportInput {
  title: string;
  description: string;
}

export interface GitMetadata {
  root: string;
  branch: string | null;
  head: string;
  dirty: boolean;
}

export interface ReportMetadata {
  schemaVersion: 1;
  source: "pi-report";
  reportKey: string;
  reportTimestamp: string;
  session: {
    id: string;
    name: string | null;
    startedAt: string | null;
    cwd: string;
    transcriptFile: string | null;
    persisted: boolean;
    leafId: string | null;
    parentSession: string | null;
    counts: ReportCounts;
  };
  runtime: {
    piVersion: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    osRelease: string;
    model: { provider: string; id: string } | null;
    thinkingLevel: string;
    activeTools: string[];
    extensionSources: string[];
  };
  git: GitMetadata | null;
}

interface SessionLikeEntry {
  type: string;
  message?: { role?: string };
}

export function parseReportInput(text: string): ReportInput | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const titleIndex = lines.findIndex((line) => line.trim().length > 0);
  if (titleIndex < 0) return null;

  const title = lines[titleIndex].trim();
  const description = lines
    .slice(titleIndex + 1)
    .join("\n")
    .trim();

  return { title, description };
}

export function countSessionEntries(
  allEntries: SessionLikeEntry[],
  activeBranch: SessionLikeEntry[],
): ReportCounts {
  const counts: ReportCounts = {
    activeBranchEntries: activeBranch.length,
    totalSessionEntries: allEntries.length,
    userPrompts: 0,
    assistantTurns: 0,
    toolResults: 0,
    bashExecutions: 0,
    customMessages: 0,
  };

  for (const entry of activeBranch) {
    if (entry.type === "custom_message") counts.customMessages++;
    if (entry.type !== "message") continue;

    switch (entry.message?.role) {
      case "user":
        counts.userPrompts++;
        break;
      case "assistant":
        counts.assistantTurns++;
        break;
      case "toolResult":
        counts.toolResults++;
        break;
      case "bashExecution":
        counts.bashExecutions++;
        break;
    }
  }

  return counts;
}

function inlineCode(value: string | null): string {
  if (value === null || value === "") return "—";
  return `\`${value.replace(/`/g, "\\`")}\``;
}

export function buildIssueDescription(input: ReportInput, metadata: ReportMetadata): string {
  const { session, runtime, git } = metadata;
  const reportText = input.description || "_No additional details provided._";
  const model = runtime.model ? `${runtime.model.provider}/${runtime.model.id}` : null;

  const lines = [
    "## User report",
    "",
    reportText,
    "",
    "## Session",
    "",
    `- Reported at: ${inlineCode(metadata.reportTimestamp)}`,
    `- Session ID: ${inlineCode(session.id)}`,
    `- Session started: ${inlineCode(session.startedAt)}`,
    `- Session name: ${inlineCode(session.name)}`,
    `- Working directory: ${inlineCode(session.cwd)}`,
    `- Transcript: ${inlineCode(session.transcriptFile)}`,
    `- Current leaf: ${inlineCode(session.leafId)}`,
    `- Parent session: ${inlineCode(session.parentSession)}`,
    "",
    "## Counts (active branch unless noted)",
    "",
    `- User prompts: ${session.counts.userPrompts}`,
    `- Assistant turns: ${session.counts.assistantTurns}`,
    `- Tool results: ${session.counts.toolResults}`,
    `- Bash executions: ${session.counts.bashExecutions}`,
    `- Custom messages: ${session.counts.customMessages}`,
    `- Active-branch entries: ${session.counts.activeBranchEntries}`,
    `- Total session entries: ${session.counts.totalSessionEntries}`,
    "",
    "## Runtime",
    "",
    `- Pi: ${inlineCode(runtime.piVersion)}`,
    `- Model: ${inlineCode(model)}`,
    `- Thinking level: ${inlineCode(runtime.thinkingLevel)}`,
    `- Node: ${inlineCode(runtime.nodeVersion)}`,
    `- Platform: ${inlineCode(`${runtime.platform}/${runtime.arch} ${runtime.osRelease}`)}`,
    `- Active tools: ${runtime.activeTools.length > 0 ? runtime.activeTools.map((tool) => inlineCode(tool)).join(", ") : "—"}`,
  ];

  if (git) {
    lines.push(
      "",
      "## Git state",
      "",
      `- Repository: ${inlineCode(git.root)}`,
      `- Branch: ${inlineCode(git.branch)}`,
      `- HEAD: ${inlineCode(git.head)}`,
      `- Dirty: ${git.dirty ? "yes" : "no"}`,
    );
  } else {
    lines.push("", "## Git state", "", "Not inside a Git worktree.");
  }

  lines.push(
    "",
    "---",
    "Created deterministically by the Pi `/report` extension. No LLM was used.",
  );

  return lines.join("\n");
}

function extractBead(value: unknown): { id: string; title?: string } | null {
  if (!value || typeof value !== "object") return null;

  const direct = value as { id?: unknown; title?: unknown; issue?: unknown };
  if (typeof direct.id === "string") {
    return {
      id: direct.id,
      title: typeof direct.title === "string" ? direct.title : undefined,
    };
  }

  if (direct.issue) return extractBead(direct.issue);
  return null;
}

/**
 * A `git commit` invocation that suppresses repository/global hooks and is
 * limited to the tracker's exported Beads JSONL file, so a report or triage
 * commit never absorbs unrelated staged changes. Shared by `/report` and
 * `/triage-report`.
 */
export function buildHardenedCommitArgs(
  emptyHooksDir: string,
  message: string,
  pathspec: string[] = [".beads/issues.jsonl"],
): string[] {
  return [
    "-c",
    `core.hooksPath=${emptyHooksDir}`,
    "commit",
    "--no-verify",
    "-m",
    message,
    "--",
    ...pathspec,
  ];
}

export function hardenedCommitArgs(emptyHooksDir: string, beadId: string): string[] {
  return buildHardenedCommitArgs(emptyHooksDir, `report: ${beadId}`);
}

export function parseCreatedBead(stdout: string): { id: string; title?: string } {
  const trimmed = stdout.trim();
  const candidates = [trimmed, ...trimmed.split("\n").reverse()];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const bead = extractBead(JSON.parse(candidate));
      if (bead) return bead;
    } catch {
      // Try the next candidate. bd or a wrapper may add informational lines.
    }
  }

  throw new Error(`bd create output did not contain a parseable issue ID: ${trimmed.slice(0, 300)}`);
}

export function commandError(command: string, code: number, stderr: string, stdout: string): Error {
  const detail = (stderr || stdout).trim() || "no diagnostic output";
  return new Error(`${command} failed with exit code ${code}: ${detail}`);
}

export interface ExecLike {
  (
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; code: number }>;
}

/**
 * Beads 1.0 has been observed to delete an empty `.beads/issues.jsonl` as a
 * side effect of some export/list operations against a database with zero
 * issues (this shows up as a bare `D .beads/issues.jsonl` in `git status`
 * even though nothing legitimate changed). If the only pending change is
 * exactly that — the tracked file being deleted, and the last *committed*
 * version of that file was itself empty — restore it: this is a harmless
 * workaround for a known upstream quirk, not real dirt.
 *
 * Shared by `/report` (before creating the first report against a freshly
 * initialized tracker) and `/triage-report` (its dirty-tracker gate on the
 * `no-candidate`/`status` paths, which run `bd`/`git` read commands against
 * a tracker that may still have zero issues). Returns `true` if the tracker
 * is clean afterward (either it always was, or this restored it); `false` if
 * there is other, real, uncommitted change that must not be touched.
 */
export async function restoreBenignEmptyExportDeletion(
  exec: ExecLike,
  trackerDir: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const status = await exec("git", ["status", "--porcelain", "--", ".beads/issues.jsonl"], {
    cwd: trackerDir,
    timeout: timeoutMs,
  });
  if (status.code !== 0) return false;

  const trimmed = status.stdout.trim();
  if (trimmed === "") return true;
  if (trimmed !== "D .beads/issues.jsonl" && trimmed !== " D .beads/issues.jsonl") {
    return false;
  }

  const committed = await exec("git", ["show", "HEAD:.beads/issues.jsonl"], {
    cwd: trackerDir,
    timeout: timeoutMs,
  });
  if (committed.code !== 0 || committed.stdout.length !== 0) return false;

  const restored = await exec("git", ["restore", "--", ".beads/issues.jsonl"], {
    cwd: trackerDir,
    timeout: timeoutMs,
  });
  return restored.code === 0;
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const LOCK_MAX_AGE_MS = 5 * 60 * 1000;
// Longer than the combined create/export/add/commit command budgets.
const LOCK_WAIT_MS = 2 * 60 * 1000;
const LOCK_RETRY_MS = 100;

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface LockTiming {
  /** How old (by mtime) an existing lock file must be before it is reclaimed as stale. */
  maxAgeMs?: number;
  /** How long to wait for the lock before giving up. */
  waitMs?: number;
  /** Poll interval while waiting for the lock. */
  retryMs?: number;
}

/**
 * Serializes `/report` and `/triage-report` tracker mutations with a plain
 * lock file plus a stale-age reclaim fallback (a crashed process never
 * permanently wedges the tracker).
 *
 * Ownership token: each acquisition writes a random token into the lock file
 * alongside the pid/timestamp. On release, the token is re-read and compared
 * before deleting the file. This closes the concrete race where: (1) this
 * process's own operation runs long enough to cross `maxAgeMs` while it is
 * still legitimately running, (2) a second process reclaims the lock as
 * stale and starts its own operation, and (3) this process's original
 * `finally` then unconditionally deletes the lock file out from under the
 * second process, breaking mutual exclusion. With the token check, step (3)
 * instead sees a foreign token and leaves the file alone; only the process
 * that currently owns the token ever deletes it. This does not close every
 * possible TOCTOU window (there is no atomic "delete iff content == X" file
 * primitive available here), but it eliminates the concrete failure mode of
 * a stale owner deleting a live replacement owner's lock.
 */
export async function withTrackerLock<T>(
  trackerDir: string,
  operation: () => Promise<T>,
  timing: LockTiming = {},
): Promise<T> {
  const lockPath = join(trackerDir, ".pi-report.lock");
  const maxAgeMs = timing.maxAgeMs ?? LOCK_MAX_AGE_MS;
  const waitMs = timing.waitMs ?? LOCK_WAIT_MS;
  const retryMs = timing.retryMs ?? LOCK_RETRY_MS;
  const deadline = Date.now() + waitMs;
  const token = randomUUID();

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n${token}\n`);
      await handle.close();
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > maxAgeMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() >= deadline) {
        let owner = "unknown owner";
        try {
          owner = (await readFile(lockPath, "utf8")).trim().replace(/\n/g, ", ");
        } catch {
          // Keep the deterministic fallback.
        }
        throw new Error(`Timed out waiting for another report operation (${owner})`);
      }
      await delay(retryMs);
    }
  }

  try {
    return await operation();
  } finally {
    try {
      const content = await readFile(lockPath, "utf8");
      if (content.includes(token)) {
        await rm(lockPath, { force: true });
      }
      // else: a later run reclaimed this lock as stale while we were still
      // running and now owns it; it is not ours to delete.
    } catch {
      // Lock file is already gone; nothing to clean up.
    }
  }
}
