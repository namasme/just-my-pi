import assert from "node:assert/strict";
import {
  buildHeartbeatHint,
  createHeartbeatState,
  decideHeartbeatNudge,
  hasUserFacingText,
  recordNudgeIssued,
  recordUserFacingSignal,
  resolveThresholdSeconds,
  type HeartbeatState,
} from "./heartbeat-core.ts";

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

const THRESHOLD_MS = 10 * 60 * 1000;

function stateAt(lastSignalAt: number, lastNudgeAt: number | null = null): HeartbeatState {
  return { lastSignalAt, lastNudgeAt };
}

// --- resolveThresholdSeconds ---------------------------------------------

await test("resolveThresholdSeconds: falls back to the default when unset", () => {
  assert.equal(resolveThresholdSeconds(undefined), 10 * 60);
});

await test("resolveThresholdSeconds: accepts a positive override", () => {
  assert.equal(resolveThresholdSeconds("1"), 1);
  assert.equal(resolveThresholdSeconds("45"), 45);
});

await test("resolveThresholdSeconds: rejects non-positive/invalid overrides", () => {
  assert.equal(resolveThresholdSeconds("0"), 10 * 60);
  assert.equal(resolveThresholdSeconds("-5"), 10 * 60);
  assert.equal(resolveThresholdSeconds("not-a-number"), 10 * 60);
  assert.equal(resolveThresholdSeconds(""), 10 * 60);
});

// --- decideHeartbeatNudge --------------------------------------------------

await test("decideHeartbeatNudge: under threshold -> no nudge", () => {
  const now = 1_000_000;
  const state = stateAt(now - (THRESHOLD_MS - 1));
  const hint = decideHeartbeatNudge({ now, thresholdMs: THRESHOLD_MS, isMainAgent: true, state });
  assert.equal(hint, undefined);
});

await test("decideHeartbeatNudge: at/over threshold with no prior nudge -> hint", () => {
  const now = 1_000_000;
  const state = stateAt(now - THRESHOLD_MS);
  const hint = decideHeartbeatNudge({ now, thresholdMs: THRESHOLD_MS, isMainAgent: true, state });
  assert.equal(typeof hint, "string");
  assert.match(hint!, /not updated the user in 10 minutes/);
  assert.match(hint!, /Before your next tool call/);
});

await test("decideHeartbeatNudge: second call right after a nudge -> no nudge", () => {
  const signalAt = 1_000_000;
  const nudgeNow = signalAt + THRESHOLD_MS;
  const stateAfterSignal = stateAt(signalAt);
  const hintAtThreshold = decideHeartbeatNudge({
    now: nudgeNow,
    thresholdMs: THRESHOLD_MS,
    isMainAgent: true,
    state: stateAfterSignal,
  });
  assert.equal(typeof hintAtThreshold, "string");

  const stateAfterNudge = recordNudgeIssued(stateAfterSignal, nudgeNow);
  const checkShortlyAfter = nudgeNow + 1_000; // 1s later, still mid-tool-call storm
  const secondHint = decideHeartbeatNudge({
    now: checkShortlyAfter,
    thresholdMs: THRESHOLD_MS,
    isMainAgent: true,
    state: stateAfterNudge,
  });
  assert.equal(secondHint, undefined);
});

await test("decideHeartbeatNudge: nudges again once another full threshold elapses post-nudge", () => {
  const signalAt = 1_000_000;
  const firstNudgeAt = signalAt + THRESHOLD_MS;
  const stateAfterNudge = recordNudgeIssued(stateAt(signalAt), firstNudgeAt);

  const stillWithinThreshold = firstNudgeAt + THRESHOLD_MS - 1;
  assert.equal(
    decideHeartbeatNudge({
      now: stillWithinThreshold,
      thresholdMs: THRESHOLD_MS,
      isMainAgent: true,
      state: stateAfterNudge,
    }),
    undefined,
  );

  const pastAnotherThreshold = firstNudgeAt + THRESHOLD_MS;
  const secondHint = decideHeartbeatNudge({
    now: pastAnotherThreshold,
    thresholdMs: THRESHOLD_MS,
    isMainAgent: true,
    state: stateAfterNudge,
  });
  assert.equal(typeof secondHint, "string");
});

await test("decideHeartbeatNudge: user-facing text resets the clock -> no nudge until threshold again", () => {
  const nudgedAt = 1_000_000;
  const stateBeforeText = recordNudgeIssued(stateAt(nudgedAt - THRESHOLD_MS), nudgedAt);

  const textAt = nudgedAt + 5_000; // assistant finally said something
  const stateAfterText = recordUserFacingSignal(textAt);
  assert.equal(stateAfterText.lastNudgeAt, null, "a fresh signal clears the nudge memory");

  const rightAfterText = textAt + 1_000;
  assert.equal(
    decideHeartbeatNudge({
      now: rightAfterText,
      thresholdMs: THRESHOLD_MS,
      isMainAgent: true,
      state: stateAfterText,
    }),
    undefined,
  );

  const stillBeforeThreshold = textAt + THRESHOLD_MS - 1;
  assert.equal(
    decideHeartbeatNudge({
      now: stillBeforeThreshold,
      thresholdMs: THRESHOLD_MS,
      isMainAgent: true,
      state: stateAfterText,
    }),
    undefined,
  );

  const pastThresholdAgain = textAt + THRESHOLD_MS;
  const hint = decideHeartbeatNudge({
    now: pastThresholdAgain,
    thresholdMs: THRESHOLD_MS,
    isMainAgent: true,
    state: stateAfterText,
  });
  assert.equal(typeof hint, "string");
});

await test("decideHeartbeatNudge: subagent is always a no-op, even far over threshold", () => {
  const now = 1_000_000;
  const state = stateAt(now - THRESHOLD_MS * 10);
  const hint = decideHeartbeatNudge({ now, thresholdMs: THRESHOLD_MS, isMainAgent: false, state });
  assert.equal(hint, undefined);
});

await test("decideHeartbeatNudge: createHeartbeatState starts a clock with no prior nudge", () => {
  const now = 1_000_000;
  const state = createHeartbeatState(now);
  assert.equal(state.lastSignalAt, now);
  assert.equal(state.lastNudgeAt, null);
  assert.equal(
    decideHeartbeatNudge({ now, thresholdMs: THRESHOLD_MS, isMainAgent: true, state }),
    undefined,
    "a brand new session must not nudge immediately",
  );
});

// --- buildHeartbeatHint -----------------------------------------------------

await test("buildHeartbeatHint: singular vs plural minutes", () => {
  assert.match(buildHeartbeatHint(1), /\b1 minute\b(?! s)/);
  assert.doesNotMatch(buildHeartbeatHint(1), /1 minutes/);
  assert.match(buildHeartbeatHint(15), /15 minutes\b/);
});

// --- hasUserFacingText -------------------------------------------------------

await test("hasUserFacingText: true for a non-empty text block", () => {
  assert.equal(hasUserFacingText([{ type: "text", text: "Here's the plan." }]), true);
});

await test("hasUserFacingText: false for undefined/empty/whitespace-only content", () => {
  assert.equal(hasUserFacingText(undefined), false);
  assert.equal(hasUserFacingText(null), false);
  assert.equal(hasUserFacingText([]), false);
  assert.equal(hasUserFacingText([{ type: "text", text: "" }]), false);
  assert.equal(hasUserFacingText([{ type: "text", text: "   \n\t  " }]), false);
});

await test("hasUserFacingText: false for thinking/tool_use-only blocks (no text block)", () => {
  assert.equal(hasUserFacingText([{ type: "thinking", text: "planning out loud" }]), false);
  assert.equal(hasUserFacingText([{ type: "tool_use" }]), false);
});

await test("hasUserFacingText: a non-empty text block among non-text blocks still counts", () => {
  assert.equal(
    hasUserFacingText([{ type: "thinking", text: "internal" }, { type: "tool_use" }, { type: "text", text: "ok" }]),
    true,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
