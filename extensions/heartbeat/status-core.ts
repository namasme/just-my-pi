// Pure decision/formatting logic for the pinned "latest from agent" status
// widget. No pi/omp imports here so this file can be unit tested in
// isolation (see status-core.test.ts).

import type { AssistantContentBlockLike } from "./heartbeat-core.ts";

/** Default delay (seconds) the widget waits, after a turn starts, before appearing. */
export const DEFAULT_STATUS_DELAY_SECONDS = 20;

/** Assumed terminal width when `process.stdout.columns` is unavailable. */
export const DEFAULT_STATUS_WIDTH = 100;

/** Reserved columns (e.g. editor border/padding) subtracted from the terminal width. */
const WIDTH_MARGIN = 4;

/** Maximum number of wrapped body lines shown below the header. */
const MAX_BODY_LINES = 4;

/**
 * Resolves the "how long to wait before showing the widget" delay from an
 * environment variable value, falling back to the default for anything that
 * isn't a positive, finite number of seconds.
 */
export function resolveStatusDelaySeconds(envValue: string | undefined): number {
  if (envValue === undefined) return DEFAULT_STATUS_DELAY_SECONDS;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STATUS_DELAY_SECONDS;
  return parsed;
}

/**
 * Resolves the wrap width for the widget body from `process.stdout.columns`
 * (or the default terminal width when it's missing/invalid), minus the
 * reserved margin. Never returns less than 1.
 */
export function resolveWidgetWidth(columns: number | undefined): number {
  const base = typeof columns === "number" && Number.isFinite(columns) && columns > 0 ? columns : DEFAULT_STATUS_WIDTH;
  return Math.max(1, base - WIDTH_MARGIN);
}

/**
 * Per-main-session pinned-status state.
 *
 * `turnStartedAt` resets on every `before_agent_start` (a fresh prompt or a
 * steer) — that is what "this turn" means throughout this module.
 *
 * `lastUpdateAt`/`latestText` track the most recent user-facing assistant
 * text seen *this turn*; both stay `null` until the first one arrives.
 *
 * `toolCallsSinceUpdate` counts tool results since that last update, or
 * since the turn started when there hasn't been one yet.
 *
 * `loopRunning` is true from `agent_start` until `agent_end`; the widget is
 * hidden whenever it's false.
 */
export interface StatusState {
  loopRunning: boolean;
  turnStartedAt: number;
  lastUpdateAt: number | null;
  latestText: string | null;
  toolCallsSinceUpdate: number;
}

export function createStatusState(now: number): StatusState {
  return { loopRunning: false, turnStartedAt: now, lastUpdateAt: null, latestText: null, toolCallsSinceUpdate: 0 };
}

/**
 * A fresh user prompt or steer: starts a new turn, clearing any update from
 * the previous one. `loopRunning` carries over from `prior` (a steer arrives
 * mid-loop without a new `agent_start`; a brand new prompt's `agent_start`
 * follows immediately after and sets it itself).
 */
export function resetTurn(now: number, prior?: StatusState): StatusState {
  return { loopRunning: prior?.loopRunning ?? false, turnStartedAt: now, lastUpdateAt: null, latestText: null, toolCallsSinceUpdate: 0 };
}

/** The agent loop started running: the widget may now appear once its delay elapses. */
export function startLoop(state: StatusState): StatusState {
  return { ...state, loopRunning: true };
}

/** The agent loop ended: hide the widget until the next turn starts. */
export function endLoop(state: StatusState): StatusState {
  return { ...state, loopRunning: false };
}

/** A tool call completed: bump the since-last-update counter. */
export function recordToolResult(state: StatusState): StatusState {
  return { ...state, toolCallsSinceUpdate: state.toolCallsSinceUpdate + 1 };
}

/** The assistant said something user-facing: record it and reset the counter. */
export function recordAssistantText(state: StatusState, now: number, text: string): StatusState {
  return { ...state, lastUpdateAt: now, latestText: text, toolCallsSinceUpdate: 0 };
}

/**
 * Extracts and joins every non-empty text block from assistant message
 * content, in order. Mirrors `hasUserFacingText`'s notion of "user-facing"
 * (text blocks only; thinking/tool-call blocks are ignored).
 */
export function extractUserFacingText(content: readonly AssistantContentBlockLike[] | null | undefined): string {
  if (!content) return "";
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0)
    .map((block) => block.text as string)
    .join(" ");
}

/** Formats a duration as `45s`, `3m`, or `1h 5m` — floored, never rounded up. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** Word-wraps already-collapsed text to `width` columns, hard-breaking overlong words. */
function wrapAll(collapsed: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of collapsed.split(" ")) {
    let remaining = word;
    while (remaining.length > width) {
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }
      lines.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    if (current.length === 0) {
      current = remaining;
    } else if (current.length + 1 + remaining.length <= width) {
      current += ` ${remaining}`;
    } else {
      lines.push(current);
      current = remaining;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Collapses whitespace (including newlines, so multi-paragraph text becomes
 * one run of words), word-wraps to `width` columns, and caps the result at
 * `maxLines`, appending an ellipsis to the last line when content had to be
 * cut. A single word longer than `width` is hard-broken across lines rather
 * than overflowing it.
 */
export function wrapText(rawText: string, width: number, maxLines: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeMaxLines = Math.max(1, Math.floor(maxLines));
  const collapsed = rawText.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return [];

  const all = wrapAll(collapsed, safeWidth);
  if (all.length <= safeMaxLines) return all;

  const kept = all.slice(0, safeMaxLines);
  const ellipsis = "…";
  const last = kept[safeMaxLines - 1];
  kept[safeMaxLines - 1] =
    last.length + ellipsis.length > safeWidth
      ? `${last.slice(0, Math.max(0, safeWidth - ellipsis.length)).trimEnd()}${ellipsis}`
      : `${last}${ellipsis}`;
  return kept;
}

export interface WidgetRenderOptions {
  /** Milliseconds since turn start before the widget may appear. */
  delayMs: number;
  /** Final wrap width for the body text (already margin-adjusted). */
  width: number;
}

/**
 * Pure decision: what should the pinned widget show right now, if anything?
 * Returns `undefined` when the widget should be hidden — the loop isn't
 * running, or this turn hasn't yet run past its startup delay.
 *
 * The string-array widget path (`ctx.ui.setWidget`) renders plain `Text`
 * components per line with no per-character styling hook available to a
 * plain string, so this returns unstyled plain text rather than reaching for
 * theme colors.
 */
export function computeWidgetLines(state: StatusState, now: number, options: WidgetRenderOptions): string[] | undefined {
  if (!state.loopRunning) return undefined;

  const elapsedTurnMs = Math.max(0, now - state.turnStartedAt);
  if (elapsedTurnMs < options.delayMs) return undefined;

  const elapsed = formatDuration(elapsedTurnMs);

  if (state.lastUpdateAt === null) {
    return [`◆ Working ${elapsed} · ${state.toolCallsSinceUpdate} tool calls · no update yet this turn`];
  }

  const age = formatDuration(Math.max(0, now - state.lastUpdateAt));
  const header = `◆ Latest from agent · ${age} ago · ${state.toolCallsSinceUpdate} tool calls since · working ${elapsed}`;
  const body = wrapText(state.latestText ?? "", options.width, MAX_BODY_LINES);
  return [header, ...body];
}
