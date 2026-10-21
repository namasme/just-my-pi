import assert from "node:assert/strict";
import {
  bucketForTokens,
  curveForModel,
  DEFAULT_CONTEXT_WINDOW,
  fallbackQuality,
  resolveModelCurve,
} from "./curves.ts";
import {
  buildDelegationHint,
  createDelegationState,
  decideDelegationNudge,
  isDisabledByEnv,
  isForcedByEnv,
  NO_NUDGE_QUALITY_THRESHOLD,
  resolveTokensScale,
} from "./delegation-core.ts";

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

/** Deterministic RNG stub: always returns the same value. */
function rngAt(value: number): () => number {
  return () => value;
}

// --- curve lookup -----------------------------------------------------------

await test("curveForModel: exact model match uses its own measured buckets", () => {
  const curve = curveForModel("claude-sonnet-5", 1_000_000);
  assert.equal(bucketForTokens(curve, 100_000).q, 0.55); // 64k-128k row
  assert.equal(bucketForTokens(curve, 0).q, 1.0);
});

await test("curveForModel: flash variant matches before its non-flash base", () => {
  const flash = curveForModel("GLM-5.3-Flash", 1_048_576);
  assert.equal(bucketForTokens(flash, 0).q, 0.85, "flash's own 0-16k row, not the base model's 0.95");

  const base = curveForModel("ai-gw-logical/glm-5-3", 1_048_576);
  assert.equal(bucketForTokens(base, 0).q, 0.95, "base model must not accidentally match the flash pattern");
});

await test("curveForModel: opus 5.5 matches before plain opus 5", () => {
  const opus55 = resolveModelCurve("claude-opus-5-5");
  const opus5 = resolveModelCurve("claude-opus-5");
  assert.ok(opus55, "opus-5-5 pattern must match");
  assert.ok(opus5, "opus-5 pattern must match");
  // Both curves happen to carry identical values (opus-5-5 is a proxy for opus-5),
  // but the match itself must pick the more specific pattern first.
  assert.notEqual(opus55!.pattern.source, opus5!.pattern.source);
  assert.match("claude-opus-5-5", opus55!.pattern);
});

await test("curveForModel: unknown model falls back to fraction-of-window curve", () => {
  const curve = curveForModel("some-random-vendor/mystery-model-9", 200_000);
  assert.equal(bucketForTokens(curve, 1_000).q, 1.0); // well under 1/64 of 200k
  assert.equal(bucketForTokens(curve, 100_000).q, 0.3); // exactly 50% of window
  assert.equal(fallbackQuality(100_000, 200_000), 0.3);
});

await test("curveForModel: unknown model with no window assumes 200k", () => {
  const curve = curveForModel("totally-unknown-model", undefined);
  assert.equal(bucketForTokens(curve, DEFAULT_CONTEXT_WINDOW / 2).q, 0.3);
});

await test("curveForModel: beyond the last measured range keeps the last value", () => {
  const known = curveForModel("claude-sonnet-5", 1_000_000);
  const last = bucketForTokens(known, 2_000_000);
  assert.equal(last.q, bucketForTokens(known, 512_000).q, "no bucket past 512k -> keeps that bucket's q");

  const unknown = curveForModel("mystery-model", 100_000);
  assert.equal(bucketForTokens(unknown, 10_000_000).q, 0.3, "far past the window still keeps the last fallback q");
});

// --- decideDelegationNudge: sampling once per bucket -------------------------

await test("decideDelegationNudge: first observation in a bucket samples once", () => {
  const decision = decideDelegationNudge({
    tokens: 70_000, // glm-5-3: 64k-128k row, q=0.65 -> p=0.35
    modelId: "glm-5-3",
    contextWindow: 1_048_576,
    state: createDelegationState(),
    rng: rngAt(0.0),
    force: false,
  });
  assert.equal(decision.state.watermarkLowerBound, 64_000);
  assert.ok(decision.nudge, "rng=0.0 < p=0.35 must nudge");
  assert.equal(decision.nudge!.q, 0.65);
});

await test("decideDelegationNudge: never samples twice inside the same bucket", () => {
  const first = decideDelegationNudge({
    tokens: 70_000,
    modelId: "glm-5-3",
    contextWindow: 1_048_576,
    state: createDelegationState(),
    rng: rngAt(0.0),
    force: false,
  });
  const second = decideDelegationNudge({
    tokens: 90_000, // still in the 64k-128k bucket
    modelId: "glm-5-3",
    contextWindow: 1_048_576,
    state: first.state,
    rng: rngAt(0.0), // would nudge again if resampled
    force: false,
  });
  assert.equal(second.nudge, undefined);
  assert.equal(second.state.watermarkLowerBound, 64_000);
});

// --- decideDelegationNudge: q >= 0.95 never nudges ---------------------------

await test("decideDelegationNudge: p is forced to 0 at q >= 0.95, even with rng=0.0", () => {
  const decision = decideDelegationNudge({
    tokens: 5_000, // glm-5-3: 0-16k row, q=0.95
    modelId: "glm-5-3",
    contextWindow: 1_048_576,
    state: createDelegationState(),
    rng: rngAt(0.0),
    force: false,
  });
  assert.equal(decision.nudge, undefined);
});

await test("decideDelegationNudge: force does not override the q >= 0.95 guard", () => {
  const decision = decideDelegationNudge({
    tokens: 5_000,
    modelId: "glm-5-3",
    contextWindow: 1_048_576,
    state: createDelegationState(),
    rng: rngAt(0.0),
    force: true,
  });
  assert.equal(decision.nudge, undefined);
});

// --- decideDelegationNudge: RNG threshold behavior ---------------------------

await test("decideDelegationNudge: rng just under p nudges, rng over p does not", () => {
  // glm-5-3-flash: 64k-128k row, q=0.60 -> p=0.40
  const low = decideDelegationNudge({
    tokens: 70_000,
    modelId: "glm-5-3-flash",
    contextWindow: 1_048_576,
    state: createDelegationState(),
    rng: rngAt(0.0),
    force: false,
  });
  assert.ok(low.nudge, "rng=0.0 < p=0.40 must nudge");

  const high = decideDelegationNudge({
    tokens: 70_000,
    modelId: "glm-5-3-flash",
    contextWindow: 1_048_576,
    state: createDelegationState(),
    rng: rngAt(0.99),
    force: false,
  });
  assert.equal(high.nudge, undefined, "rng=0.99 > p=0.40 must not nudge");
});

await test("decideDelegationNudge: force samples unconditionally when q < 0.95", () => {
  const decision = decideDelegationNudge({
    tokens: 70_000, // q=0.65 < 0.95
    modelId: "glm-5-3",
    contextWindow: 1_048_576,
    state: createDelegationState(),
    rng: rngAt(0.99), // would not nudge unforced
    force: true,
  });
  assert.ok(decision.nudge);
});

// --- decideDelegationNudge: watermark reset on a drop ------------------------

await test("decideDelegationNudge: a drop below the evaluated bucket resets the watermark without sampling", () => {
  const grown = decideDelegationNudge({
    tokens: 70_000, // 64k-128k bucket, watermark -> 64_000
    modelId: "glm-5-3",
    contextWindow: 1_048_576,
    state: createDelegationState(),
    rng: rngAt(0.99), // avoid nudging so the watermark change is isolated
    force: false,
  });
  assert.equal(grown.state.watermarkLowerBound, 64_000);

  const dropped = decideDelegationNudge({
    tokens: 10_000, // compaction drops us into the 0-16k bucket
    modelId: "glm-5-3",
    contextWindow: 1_048_576,
    state: grown.state,
    rng: rngAt(0.0), // must not fire: a drop never samples
    force: false,
  });
  assert.equal(dropped.nudge, undefined);
  assert.equal(dropped.state.watermarkLowerBound, 0);

  // Re-growth back through the 64k-128k bucket is evaluated again.
  const regrown = decideDelegationNudge({
    tokens: 70_000,
    modelId: "glm-5-3",
    contextWindow: 1_048_576,
    state: dropped.state,
    rng: rngAt(0.0),
    force: false,
  });
  assert.ok(regrown.nudge, "re-entering a previously evaluated bucket after a drop must sample again");
});

// --- decideDelegationNudge: model switch keeps the watermark -----------------

await test("decideDelegationNudge: a model switch mid-session evaluates the new curve without resetting the watermark", () => {
  const underFirstModel = decideDelegationNudge({
    tokens: 70_000, // 64k-128k bucket -> watermark 64_000
    modelId: "glm-5-3",
    contextWindow: 1_048_576,
    state: createDelegationState(),
    rng: rngAt(0.99),
    force: false,
  });
  assert.equal(underFirstModel.state.watermarkLowerBound, 64_000);

  // Same tokens, switched model, same bucket boundaries -> already evaluated.
  const sameBucketNewModel = decideDelegationNudge({
    tokens: 70_000,
    modelId: "claude-sonnet-5",
    contextWindow: 1_000_000,
    state: underFirstModel.state,
    rng: rngAt(0.0), // would nudge if resampled
    force: false,
  });
  assert.equal(sameBucketNewModel.nudge, undefined, "watermark is not reset by a model switch");
  assert.equal(sameBucketNewModel.state.watermarkLowerBound, 64_000);

  // Growth into a new bucket evaluates with the new model's curve.
  const grownNewModel = decideDelegationNudge({
    tokens: 150_000, // 128k-256k bucket; sonnet-5 q=0.55 -> p=0.45
    modelId: "claude-sonnet-5",
    contextWindow: 1_000_000,
    state: sameBucketNewModel.state,
    rng: rngAt(0.0),
    force: false,
  });
  assert.ok(grownNewModel.nudge);
  assert.equal(grownNewModel.nudge!.q, 0.55, "scored with the new model's curve, not the old one's");
});

// --- env helpers --------------------------------------------------------------

await test("isDisabledByEnv / isForcedByEnv: only the literal \"1\" triggers", () => {
  assert.equal(isDisabledByEnv(undefined), false);
  assert.equal(isDisabledByEnv("0"), false);
  assert.equal(isDisabledByEnv("true"), false);
  assert.equal(isDisabledByEnv("1"), true);
  assert.equal(isForcedByEnv(undefined), false);
  assert.equal(isForcedByEnv("1"), true);
});

await test("resolveTokensScale: defaults to 1, rejects non-positive/invalid overrides", () => {
  assert.equal(resolveTokensScale(undefined), 1);
  assert.equal(resolveTokensScale("0"), 1);
  assert.equal(resolveTokensScale("-3"), 1);
  assert.equal(resolveTokensScale("not-a-number"), 1);
  assert.equal(resolveTokensScale("50"), 50);
});

// --- buildDelegationHint ------------------------------------------------------

await test("buildDelegationHint: reports rounded k-tokens, model id and q percent, with the required call to action", () => {
  const hint = buildDelegationHint(70_432, "glm-5-3", 0.65);
  assert.match(hint, /~70k tokens/);
  assert.match(hint, /glm-5-3 recalls earlier details noticeably less reliably/);
  assert.match(hint, /≈65% of short-context accuracy/);
  assert.match(hint, /delegate it to a subagent \(task tool\)/);
  assert.match(hint, /keep only its conclusions here/);
});

await test("sanity: NO_NUDGE_QUALITY_THRESHOLD matches the documented 0.95 guard", () => {
  assert.equal(NO_NUDGE_QUALITY_THRESHOLD, 0.95);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
