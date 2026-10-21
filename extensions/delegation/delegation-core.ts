// Pure decision logic for the delegation-nudge extension. No pi/omp imports here so
// this file can be unit tested in isolation (see delegation-core.test.ts).

import { bucketForTokens, curveForModel } from "./curves.ts";

/** A bucket's quality at/above which this extension never nudges (avoids noise at small contexts). */
export const NO_NUDGE_QUALITY_THRESHOLD = 0.95;

/**
 * Per-main-session watermark: the lower bound (tokens) of the highest bucket
 * already sampled this session, or `null` before the first observation.
 */
export interface DelegationState {
  watermarkLowerBound: number | null;
}

export function createDelegationState(): DelegationState {
  return { watermarkLowerBound: null };
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
 * stays in that bucket. A drop below the lowest bound of the highest
 * evaluated bucket (compaction, a context reset) resets the watermark to the
 * bucket the drop landed in, without sampling, so re-growth through that
 * range is evaluated again. A model switch mid-session evaluates the new
 * model's curve against the same watermark; it is never reset by a switch.
 */
export function decideDelegationNudge(input: DelegationDecisionInput): DelegationDecision {
  const { tokens, modelId, contextWindow, state, rng, force } = input;
  const curve = curveForModel(modelId, contextWindow);
  const bucket = bucketForTokens(curve, tokens);
  const watermark = state.watermarkLowerBound;

  if (watermark !== null && bucket.lowerBound < watermark) {
    return { state: { watermarkLowerBound: bucket.lowerBound } };
  }
  if (watermark !== null && bucket.lowerBound === watermark) {
    return { state };
  }

  const nextState: DelegationState = { watermarkLowerBound: bucket.lowerBound };
  const p = bucket.q >= NO_NUDGE_QUALITY_THRESHOLD ? 0 : clamp01(1 - bucket.q);
  const sampled = force ? p > 0 : rng() < p;
  if (!sampled) return { state: nextState };
  return { state: nextState, nudge: { tokens, q: bucket.q } };
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
