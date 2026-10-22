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

// ANSI escape sequences (CSI/OSC codes, e.g. color), stripped defensively
// before wrapping — model text shouldn't normally contain them, but a raw
// escape would otherwise land in the widget's plain-text lines verbatim.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z0-9]*(?:;[a-zA-Z0-9]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g;

/**
 * Splits text into grapheme clusters (what a terminal renders as one
 * "character") via `Intl.Segmenter`, so multi-code-point sequences — ZWJ
 * emoji, skin-tone modifiers, combining marks — are never torn apart by a
 * hard break. Falls back to code-point iteration (still surrogate-pair
 * safe, just not ZWJ-aware) if `Intl.Segmenter` is unavailable.
 */
function graphemesOf(text: string): string[] {
  if (text.length === 0) return [];
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (entry) => entry.segment);
  }
  return Array.from(text);
}

/**
 * Zero-width code points (joiners, variation selectors, combining marks,
 * skin-tone modifiers) that attach to the preceding character without
 * adding a display column. Best-effort, not a full Unicode table.
 */
function isZeroWidthCodePoint(cp: number): boolean {
  return (
    cp === 0x200c || // ZERO WIDTH NON-JOINER
    cp === 0x200d || // ZERO WIDTH JOINER
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0x180b && cp <= 0x180d) || // Mongolian variation selectors
    (cp >= 0x1ab0 && cp <= 0x1aff) || // combining diacritical marks extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // combining diacritical marks supplement
    (cp >= 0x20d0 && cp <= 0x20ff) || // combining diacritical marks for symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors (incl. emoji VS16)
    (cp >= 0xfe20 && cp <= 0xfe2f) || // combining half marks
    (cp >= 0x1f3fb && cp <= 0x1f3ff) // emoji skin-tone modifiers
  );
}

/**
 * East-Asian "Wide"/"Fullwidth" ranges plus common emoji blocks that render
 * as two terminal columns. Best-effort, not a full wcwidth table.
 */
function isWideCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f || // Hangul Jamo
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x303e && cp !== 0x303f) || // CJK Radicals..CJK Symbols
      (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana..CJK Compatibility
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
      (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
      (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x16fe0 && cp <= 0x16fff) ||
      (cp >= 0x17000 && cp <= 0x18d08) || // Tangut
      (cp >= 0x1aff0 && cp <= 0x1b2ff) || // Kana extensions
      (cp >= 0x1f200 && cp <= 0x1f2ff) || // enclosed ideographic supplement
      (cp >= 0x1f300 && cp <= 0x1f64f) || // misc symbols & pictographs, emoticons
      (cp >= 0x1f680 && cp <= 0x1f6ff) || // transport & map symbols
      (cp >= 0x1f900 && cp <= 0x1f9ff) || // supplemental symbols & pictographs
      (cp >= 0x1fa70 && cp <= 0x1faff) || // symbols & pictographs extended-A
      (cp >= 0x20000 && cp <= 0x3fffd)) // CJK Ext B+ / Supplementary Ideographic Plane
  );
}

/** Display width (terminal columns) of one grapheme cluster. */
function graphemeWidth(grapheme: string): number {
  let width = 0;
  for (const char of grapheme) {
    const cp = char.codePointAt(0) ?? 0;
    if (isZeroWidthCodePoint(cp)) continue;
    width = Math.max(width, isWideCodePoint(cp) ? 2 : 1);
  }
  return width;
}

/** Display width (terminal columns) of a string, summed grapheme by grapheme. */
function displayWidth(text: string): number {
  let width = 0;
  for (const grapheme of graphemesOf(text)) width += graphemeWidth(grapheme);
  return width;
}

/** Truncates text to at most `maxWidth` display columns, on a grapheme boundary. */
function truncateToDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let result = "";
  let width = 0;
  for (const grapheme of graphemesOf(text)) {
    const gw = graphemeWidth(grapheme);
    if (width + gw > maxWidth) break;
    result += grapheme;
    width += gw;
  }
  return result;
}

/**
 * Word-wraps already-collapsed text to `width` display columns (not UTF-16
 * length), hard-breaking overlong words on grapheme-cluster boundaries so a
 * surrogate pair or ZWJ emoji sequence is never split mid-character.
 */
function wrapAll(collapsed: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const word of collapsed.split(" ")) {
    let graphemes = graphemesOf(word);
    let wordWidth = graphemes.reduce((sum, g) => sum + graphemeWidth(g), 0);

    while (wordWidth > width) {
      if (currentWidth > 0) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      let chunk = "";
      let chunkWidth = 0;
      let consumed = 0;
      for (const g of graphemes) {
        const gw = graphemeWidth(g);
        if (chunkWidth + gw > width) break;
        chunk += g;
        chunkWidth += gw;
        consumed++;
      }
      if (consumed === 0) {
        // A single grapheme alone exceeds the width (e.g. a wide character
        // at width 1): emit it anyway rather than looping forever.
        chunk = graphemes[0];
        chunkWidth = graphemeWidth(graphemes[0]);
        consumed = 1;
      }
      lines.push(chunk);
      graphemes = graphemes.slice(consumed);
      wordWidth -= chunkWidth;
    }

    const remainder = graphemes.join("");
    if (currentWidth === 0) {
      current = remainder;
      currentWidth = wordWidth;
    } else if (currentWidth + 1 + wordWidth <= width) {
      current += ` ${remainder}`;
      currentWidth += 1 + wordWidth;
    } else {
      lines.push(current);
      current = remainder;
      currentWidth = wordWidth;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Strips ANSI escapes, collapses whitespace (including newlines, so
 * multi-paragraph text becomes one run of words), word-wraps to `width`
 * display columns, and caps the result at `maxLines`, appending an ellipsis
 * to the last line when content had to be cut. A single word longer than
 * `width` is hard-broken across lines (on grapheme boundaries) rather than
 * overflowing it.
 */
export function wrapText(rawText: string, width: number, maxLines: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeMaxLines = Math.max(1, Math.floor(maxLines));
  const collapsed = rawText.replace(ANSI_ESCAPE_PATTERN, "").replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return [];

  const all = wrapAll(collapsed, safeWidth);
  if (all.length <= safeMaxLines) return all;

  const kept = all.slice(0, safeMaxLines);
  const ellipsis = "…";
  const ellipsisWidth = displayWidth(ellipsis);
  const last = kept[safeMaxLines - 1];
  kept[safeMaxLines - 1] =
    displayWidth(last) + ellipsisWidth > safeWidth
      ? `${truncateToDisplayWidth(last, safeWidth - ellipsisWidth).trimEnd()}${ellipsis}`
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
