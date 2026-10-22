import assert from "node:assert/strict";
import {
  computeWidgetLines,
  createStatusState,
  endLoop,
  extractUserFacingText,
  formatDuration,
  recordAssistantText,
  recordToolResult,
  resetTurn,
  resolveStatusDelaySeconds,
  resolveWidgetWidth,
  startLoop,
  wrapText,
  type StatusState,
} from "./status-core.ts";

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

// Independent (deliberately not copy-pasted from status-core.ts) display-width
// measure, used only to assert wrapText's output lines fit the requested
// column budget for East-Asian-wide text.
function measureDisplayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isWide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    width += isWide ? 2 : 1;
  }
  return width;
}

// Detects an unpaired UTF-16 surrogate (half of a split astral code point).
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const DELAY_MS = 20_000;

function stateAt(overrides: Partial<StatusState> = {}): StatusState {
  return {
    loopRunning: true,
    turnStartedAt: 1_000_000 - DELAY_MS, // past the delay by default
    lastUpdateAt: null,
    latestText: null,
    toolCallsSinceUpdate: 0,
    ...overrides,
  };
}

// --- resolveStatusDelaySeconds ----------------------------------------------

await test("resolveStatusDelaySeconds: falls back to the default when unset", () => {
  assert.equal(resolveStatusDelaySeconds(undefined), 20);
});

await test("resolveStatusDelaySeconds: accepts a positive override", () => {
  assert.equal(resolveStatusDelaySeconds("2"), 2);
  assert.equal(resolveStatusDelaySeconds("45"), 45);
});

await test("resolveStatusDelaySeconds: rejects non-positive/invalid overrides", () => {
  assert.equal(resolveStatusDelaySeconds("0"), 20);
  assert.equal(resolveStatusDelaySeconds("-5"), 20);
  assert.equal(resolveStatusDelaySeconds("not-a-number"), 20);
  assert.equal(resolveStatusDelaySeconds(""), 20);
});

// --- resolveWidgetWidth ------------------------------------------------------

await test("resolveWidgetWidth: subtracts the margin from a valid column count", () => {
  assert.equal(resolveWidgetWidth(140), 136);
  assert.equal(resolveWidgetWidth(10), 6);
});

await test("resolveWidgetWidth: falls back to the default width when columns is missing/invalid", () => {
  assert.equal(resolveWidgetWidth(undefined), 96);
  assert.equal(resolveWidgetWidth(0), 96);
  assert.equal(resolveWidgetWidth(-5), 96);
  assert.equal(resolveWidgetWidth(Number.NaN), 96);
});

await test("resolveWidgetWidth: never returns less than 1", () => {
  assert.equal(resolveWidgetWidth(2), 1);
});

// --- formatDuration: boundaries ----------------------------------------------

await test("formatDuration: sub-minute durations render as seconds", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "0s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(59_999), "59s");
});

await test("formatDuration: the 60s boundary switches to minutes, not '60s'", () => {
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(119_999), "1m");
  assert.equal(formatDuration(120_000), "2m");
});

await test("formatDuration: sub-hour durations render as minutes", () => {
  assert.equal(formatDuration(180_000), "3m");
  assert.equal(formatDuration(3_599_999), "59m");
});

await test("formatDuration: the 1h boundary switches to hours, omitting '0m'", () => {
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(3_659_999), "1h");
});

await test("formatDuration: hours with a remainder show both components", () => {
  assert.equal(formatDuration(3_900_000), "1h 5m"); // 65 minutes
  assert.equal(formatDuration(7_200_000), "2h");
});

await test("formatDuration: negative durations clamp to 0s instead of going negative", () => {
  assert.equal(formatDuration(-5_000), "0s");
});

// --- wrapText -----------------------------------------------------------------

await test("wrapText: short text fits on one line, no ellipsis", () => {
  assert.deepEqual(wrapText("hello world", 40, 4), ["hello world"]);
});

await test("wrapText: collapses internal whitespace and multi-paragraph newlines", () => {
  assert.deepEqual(wrapText("first  paragraph.\n\nsecond   paragraph.", 60, 4), ["first paragraph. second paragraph."]);
});

await test("wrapText: empty/whitespace-only text wraps to no lines", () => {
  assert.deepEqual(wrapText("", 40, 4), []);
  assert.deepEqual(wrapText("   \n\t  ", 40, 4), []);
});

await test("wrapText: wraps on word boundaries without exceeding width, no maxLines cut", () => {
  const text = "one two three four five six seven eight";
  const lines = wrapText(text, 10, 10); // maxLines large enough that nothing is cut
  for (const line of lines) assert.ok(line.length <= 10, `line "${line}" exceeds width 10`);
  assert.equal(lines.join(" "), text, "rejoining wrapped lines must reconstruct the original words");
  assert.ok(!lines[lines.length - 1].endsWith("…"), "nothing should be cut when maxLines is not exceeded");
});

await test("wrapText: truncates with an ellipsis when content exceeds maxLines", () => {
  const lines = wrapText("one two three four five six seven eight nine ten", 10, 2);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(line.length <= 10, `line "${line}" exceeds width 10`);
  assert.ok(lines[1].endsWith("…"), `expected last line to end with an ellipsis, got "${lines[1]}"`);
});

await test("wrapText: a single word longer than width is hard-broken across lines", () => {
  const lines = wrapText("supercalifragilisticexpialidocious", 10, 4);
  assert.ok(lines.length > 1, "expected the overlong word to span multiple lines");
  for (const line of lines) assert.ok(line.length <= 10, `line "${line}" exceeds width 10`);
  assert.equal(lines.join(""), "supercalifragilisticexpialidocious");
});

await test("wrapText: a single overlong word that still doesn't fit in maxLines gets ellipsized", () => {
  const word = "a".repeat(50);
  const lines = wrapText(word, 10, 2);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(line.length <= 10, `line "${line}" exceeds width 10`);
  assert.ok(lines[1].endsWith("…"));
});

// --- wrapText: display width (CJK/wide chars), grapheme safety, ANSI -----------

await test("wrapText: CJK text wraps by display width, not UTF-16 length, at width 16", () => {
  const text = "こんにちは世界、これは日本語のテストです。".repeat(2);
  const lines = wrapText(text, 16, 20); // generous maxLines: nothing should be cut
  assert.ok(lines.length > 1, "expected wide text to need more than one line at width 16");
  for (const line of lines) {
    assert.ok(measureDisplayWidth(line) <= 16, `line "${line}" measures ${measureDisplayWidth(line)} > 16 display columns`);
  }
  assert.equal(lines.join(""), text, "no characters lost across the hard break");
});

await test("wrapText: CJK text wraps by display width at width 96", () => {
  const text = "あ".repeat(80); // 80 wide chars = 160 display columns
  const lines = wrapText(text, 96, 20);
  assert.ok(lines.length > 1, "160 display columns must need more than one line at width 96");
  for (const line of lines) {
    assert.ok(measureDisplayWidth(line) <= 96, `line "${line}" measures ${measureDisplayWidth(line)} > 96 display columns`);
  }
  assert.equal(lines.join(""), text);
});

await test("wrapText: hard-breaking an overlong word never splits an astral code point", () => {
  const text = `x ${"𠮷".repeat(40)} y`; // 𠮷 (U+20B B7) is outside the BMP: a surrogate pair
  const lines = wrapText(text, 5, 20); // generous maxLines: verify the break itself, not truncation
  for (const line of lines) {
    assert.ok(!LONE_SURROGATE_PATTERN.test(line), `line "${line}" contains an unpaired surrogate`);
  }
});

await test("wrapText: a ZWJ emoji sequence stays whole across a hard break", () => {
  const familyEmoji = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"; // 👨‍👩‍👧‍👦, one grapheme cluster
  const text = `${"a".repeat(10)}${familyEmoji}${"b".repeat(10)}`; // one long "word", no spaces
  const lines = wrapText(text, 8, 20);
  assert.equal(lines.join(""), text, "no characters lost/reordered across the hard break");
  assert.ok(
    lines.some((line) => line.includes(familyEmoji)),
    "the ZWJ sequence must land intact on a single line, never split mid-cluster",
  );
});

await test("wrapText: ANSI escape sequences are stripped before wrapping", () => {
  const withAnsi = "\u001b[31mred text\u001b[0m and \u001b[1mbold\u001b[0m too";
  const lines = wrapText(withAnsi, 40, 4);
  assert.deepEqual(lines, ["red text and bold too"]);
  for (const line of lines) assert.ok(!line.includes("\u001b"), `line "${line}" still contains a raw ANSI escape`);
});

// --- extractUserFacingText ------------------------------------------------------

await test("extractUserFacingText: joins non-empty text blocks in order", () => {
  assert.equal(
    extractUserFacingText([
      { type: "text", text: "Here's the plan." },
      { type: "tool_use" },
      { type: "text", text: "Starting now." },
    ]),
    "Here's the plan. Starting now.",
  );
});

await test("extractUserFacingText: ignores thinking/tool blocks and blank text", () => {
  assert.equal(
    extractUserFacingText([
      { type: "thinking", text: "internal" },
      { type: "text", text: "   " },
      { type: "tool_use" },
    ]),
    "",
  );
});

await test("extractUserFacingText: returns empty string for undefined/null/empty content", () => {
  assert.equal(extractUserFacingText(undefined), "");
  assert.equal(extractUserFacingText(null), "");
  assert.equal(extractUserFacingText([]), "");
});

// --- StatusState transitions --------------------------------------------------

await test("createStatusState: starts with the loop not running and no update", () => {
  const state = createStatusState(1_000_000);
  assert.equal(state.loopRunning, false);
  assert.equal(state.turnStartedAt, 1_000_000);
  assert.equal(state.lastUpdateAt, null);
  assert.equal(state.latestText, null);
  assert.equal(state.toolCallsSinceUpdate, 0);
});

await test("resetTurn: clears update/counter but carries loopRunning from prior state", () => {
  const prior = recordAssistantText(recordToolResult(stateAt({ loopRunning: true })), 1_000_000, "hi");
  const reset = resetTurn(2_000_000, prior);
  assert.equal(reset.loopRunning, true, "loopRunning carries over from prior state");
  assert.equal(reset.turnStartedAt, 2_000_000);
  assert.equal(reset.lastUpdateAt, null);
  assert.equal(reset.latestText, null);
  assert.equal(reset.toolCallsSinceUpdate, 0);
});

await test("resetTurn: with no prior state, loopRunning defaults to false", () => {
  const reset = resetTurn(2_000_000);
  assert.equal(reset.loopRunning, false);
});

await test("startLoop / endLoop: toggle loopRunning without touching other fields", () => {
  const base = stateAt({ loopRunning: false, latestText: "keep me", toolCallsSinceUpdate: 3 });
  const started = startLoop(base);
  assert.equal(started.loopRunning, true);
  assert.equal(started.latestText, "keep me");
  assert.equal(started.toolCallsSinceUpdate, 3);

  const ended = endLoop(started);
  assert.equal(ended.loopRunning, false);
  assert.equal(ended.latestText, "keep me");
});

await test("recordToolResult: increments the since-last-update counter", () => {
  const s1 = recordToolResult(stateAt({ toolCallsSinceUpdate: 0 }));
  assert.equal(s1.toolCallsSinceUpdate, 1);
  const s2 = recordToolResult(s1);
  assert.equal(s2.toolCallsSinceUpdate, 2);
});

await test("recordAssistantText: sets lastUpdateAt/latestText and resets the counter", () => {
  const withCalls = recordToolResult(recordToolResult(stateAt()));
  const updated = recordAssistantText(withCalls, 1_500_000, "Status update.");
  assert.equal(updated.lastUpdateAt, 1_500_000);
  assert.equal(updated.latestText, "Status update.");
  assert.equal(updated.toolCallsSinceUpdate, 0);
});

// --- computeWidgetLines: visibility ---------------------------------------------

await test("computeWidgetLines: hidden while the loop isn't running", () => {
  const state = stateAt({ loopRunning: false });
  assert.equal(computeWidgetLines(state, 1_000_000, { delayMs: DELAY_MS, width: 80 }), undefined);
});

await test("computeWidgetLines: hidden after agent_end even far past the delay", () => {
  const state = endLoop(stateAt({ turnStartedAt: 0 }));
  assert.equal(computeWidgetLines(state, 1_000_000, { delayMs: DELAY_MS, width: 80 }), undefined);
});

await test("computeWidgetLines: hidden before the delay has elapsed", () => {
  const now = 1_000_000;
  const state = stateAt({ turnStartedAt: now - (DELAY_MS - 1) });
  assert.equal(computeWidgetLines(state, now, { delayMs: DELAY_MS, width: 80 }), undefined);
});

await test("computeWidgetLines: visible once the delay has elapsed", () => {
  const now = 1_000_000;
  const state = stateAt({ turnStartedAt: now - DELAY_MS });
  const lines = computeWidgetLines(state, now, { delayMs: DELAY_MS, width: 80 });
  assert.ok(Array.isArray(lines));
});

// --- computeWidgetLines: no-update state ----------------------------------------

await test("computeWidgetLines: no-update state is a single line with elapsed and tool count", () => {
  const now = 1_000_000;
  const state = stateAt({ turnStartedAt: now - 185_000, toolCallsSinceUpdate: 4 });
  const lines = computeWidgetLines(state, now, { delayMs: DELAY_MS, width: 80 });
  assert.deepEqual(lines, ["◆ Working 3m · 4 tool calls · no update yet this turn"]);
});

// --- computeWidgetLines: header counts with an update ---------------------------

await test("computeWidgetLines: header reports age, tool-call count since, and elapsed", () => {
  const now = 1_000_000;
  const turnStartedAt = now - 185_000; // 3m working
  const lastUpdateAt = now - 45_000; // 45s ago
  const state = stateAt({ turnStartedAt, lastUpdateAt, latestText: "All checks passed.", toolCallsSinceUpdate: 2 });
  const lines = computeWidgetLines(state, now, { delayMs: DELAY_MS, width: 80 });
  assert.equal(lines?.[0], "◆ Latest from agent · 45s ago · 2 tool calls since · working 3m");
  assert.deepEqual(lines?.slice(1), ["All checks passed."]);
});

await test("computeWidgetLines: body is word-wrapped and capped at 4 lines with ellipsis", () => {
  const now = 1_000_000;
  const longText = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
  const state = stateAt({ turnStartedAt: now - DELAY_MS, lastUpdateAt: now - 1_000, latestText: longText });
  const lines = computeWidgetLines(state, now, { delayMs: DELAY_MS, width: 12 });
  assert.ok(lines);
  // header + at most 4 body lines
  assert.ok(lines!.length <= 5);
  const bodyLines = lines!.slice(1);
  assert.ok(bodyLines.length <= 4);
  assert.ok(bodyLines[bodyLines.length - 1].endsWith("…"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
