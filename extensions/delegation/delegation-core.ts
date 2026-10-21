// Pure decision logic for the delegation-nudge extension. No pi/omp imports here so
// this file can be unit tested in isolation (see delegation-core.test.ts).

import {
  bucketForTokens,
  curveForModel,
  DEFAULT_CONTEXT_WINDOW,
  fallbackQuality,
  MEASURED_CURVE_CEILING,
  resolveModelCurve,
} from "./curves.ts";

/** A bucket's quality at/above which this extension never nudges (avoids noise at small contexts). */
export const NO_NUDGE_QUALITY_THRESHOLD = 0.95;

/**
 * Per-main-session watermark: the lower bound (tokens) of the highest bucket
 * already sampled this session, or `null` before the first observation.
 * `lastTokens` is the last observed absolute token count, or `null` before
 * the first observation; it decides a genuine drop (compaction) independent
 * of which curve's bucket grid is in effect.
 */
export interface DelegationState {
  watermarkLowerBound: number | null;
  lastTokens: number | null;
}

export function createDelegationState(): DelegationState {
  return { watermarkLowerBound: null, lastTokens: null };
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export interface DelegationDecisionInput {
  /** Current main-agent context tokens. */
  tokens: number;
  /** omp model id to look up a curve for. */
  modelId: string;
  /** The model's context window, when known (falls back to a default otherwise). */
  contextWindow: number | undefined;
  state: DelegationState;
  /** Injected RNG returning a value in [0, 1); `Math.random` in production. */
  rng: () => number;
  /** JUST_MY_PI_DELEGATION_FORCE: forces p=1 for every newly entered bucket with q < 0.95. */
  force: boolean;
}

export interface DelegationDecision {
  /** Updated watermark; callers must persist this even when no nudge fires. */
  state: DelegationState;
  /** Present only on a positive sample. */
  nudge?: { tokens: number; q: number };
}

/**
 * Pure decision: should a delegation nudge be sampled right now, and what is
 * the updated per-session watermark?
 *
 * Buckets are the current model's curve's token ranges (see curves.ts). A
 * newly entered bucket -- strictly higher than the highest bucket evaluated
 * so far this session -- is sampled exactly once: never again while context
 * stays in that bucket. In the bucket past the measured ceiling, a known
 * model's quality is evaluated at the actual observed token count (not
 * pinned to the ceiling), since that bucket spans a wide, window-dependent
 * range.
 *
 * A genuine drop in observed tokens (compaction, a context reset) resets
 * the watermark to the bucket the drop landed in, without sampling, so
 * re-growth through that range is evaluated again. A model switch
 * mid-session evaluates the new model's curve against the same watermark
 * and is never mistaken for a drop merely because the new curve's bucket
 * grid lands on a lower lowerBound at the same (or a higher) token count.
 */
export function decideDelegationNudge(input: DelegationDecisionInput): DelegationDecision {
  const { tokens, modelId, contextWindow, state, rng, force } = input;
  const curve = curveForModel(modelId, contextWindow);
  const bucket = bucketForTokens(curve, tokens);
  const watermark = state.watermarkLowerBound;
  const droppedTokens = state.lastTokens !== null && tokens < state.lastTokens;

  if (droppedTokens) {
    return { state: { watermarkLowerBound: bucket.lowerBound, lastTokens: tokens } };
  }
  if (watermark !== null && bucket.lowerBound <= watermark) {
    // Already evaluated this bucket, or a model switch landed on a
    // lower-bound bucket under a different curve grid without tokens
    // actually decreasing: keep the watermark as-is rather than resetting it.
    return { state: { watermarkLowerBound: watermark, lastTokens: tokens } };
  }

  const window = contextWindow !== undefined && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  const q =
    bucket.lowerBound >= MEASURED_CURVE_CEILING && resolveModelCurve(modelId) !== undefined
      ? fallbackQuality(tokens, window)
      : bucket.q;

  const nextState: DelegationState = { watermarkLowerBound: bucket.lowerBound, lastTokens: tokens };
  const p = q >= NO_NUDGE_QUALITY_THRESHOLD ? 0 : clamp01(1 - q);
  const sampled = force ? p > 0 : rng() < p;
  if (!sampled) return { state: nextState };
  return { state: nextState, nudge: { tokens, q } };
}

export type DelegationNudge = NonNullable<DelegationDecision["nudge"]>;

/**
 * At most one nudge is delivered per tool batch. A sample that wins while the
 * batch already delivered one is deferred (never discarded and re-rolled:
 * re-rolling a suppressed win until one roll loses would cut the effective
 * per-bucket probability from p to p^k). The newest winner supersedes an older
 * pending one, since it reflects the larger context.
 */
export function resolveNudgeDelivery(input: {
  sampled: DelegationNudge | undefined;
  pending: DelegationNudge | undefined;
  deliveredThisBatch: boolean;
}): { deliver?: DelegationNudge; pending?: DelegationNudge } {
  const candidate = input.sampled ?? input.pending;
  if (!candidate) return {};
  if (input.deliveredThisBatch) return { pending: candidate };
  return { deliver: candidate };
}

/** `JUST_MY_PI_DELEGATION_DISABLE=1` turns the extension off entirely. */
export function isDisabledByEnv(envValue: string | undefined): boolean {
  return envValue === "1";
}

/** `JUST_MY_PI_DELEGATION_FORCE=1` forces p=1 for every newly entered bucket with q < 0.95, for smoke tests. */
export function isForcedByEnv(envValue: string | undefined): boolean {
  return envValue === "1";
}

/**
 * `JUST_MY_PI_DELEGATION_TOKENS_SCALE`: test-only multiplier applied to the
 * observed token count before bucket lookup, so a cheap smoke-test prompt
 * can reach a q < 0.95 bucket without actually filling the context window.
 * Anything other than a positive finite number leaves the scale at 1 (no-op).
 */
export function resolveTokensScale(envValue: string | undefined): number {
  if (envValue === undefined) return 1;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

/** Builds the developer-facing nudge text delivered as `additionalContext`. */
export function buildDelegationHint(tokens: number, modelId: string, q: number): string {
  const kTokens = Math.round(tokens / 1000);
  const qPercent = Math.round(q * 100);
  return (
    `Context is at ~${kTokens}k tokens; ${modelId} recalls earlier details noticeably less reliably at this size ` +
    `(\u2248${qPercent}% of short-context accuracy on long-context retrieval benchmarks). Before the next ` +
    "multi-step investigation or bulk read, delegate it to a subagent (task tool) with a self-contained brief, " +
    "and keep only its conclusions here."
  );
}
