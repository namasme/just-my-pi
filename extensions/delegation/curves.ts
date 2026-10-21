// Relative long-context retrieval quality (q) by token range, per model.
//
// Source: Context Arena GDM MRCR v2 (8-needle, "Full" mode) per-bin data,
// https://contextarena.ai/api/needle-summary?needles=8, pulled 2026-10-21.
// See the research notes this was transcribed from (context-curves.md,
// collected 2026-10-21) for full methodology, raw scores, confidence
// intervals and caveats. `q` is the bin's mean MRCR score divided by the
// model's 0-8k score, capped at 1.00.
//
// Buckets below use the "Compact step tables for the extension" figures from
// that research (rel values for the default/"max" reasoning level, rounded
// to 0.05). `lowerBound` is inclusive: a token count is scored by the
// highest bucket whose lowerBound it has reached, and a count past the last
// bucket keeps that bucket's `q` ("beyond the last measured range, use the
// last value").
//
// PROXY rows -- the model itself has no Context Arena length sweep, so a
// same-vendor predecessor or sibling's curve stands in:
//   - deepseek-v4-1-flash -> DeepSeek-V4-Flash-0731 (weaker proxy than usual:
//     V4.1 has a different, newer KV-compression architecture)
//   - gpt-6-sol            -> GPT-5.6 Sol
//   - claude-opus-5-5       -> Claude Opus 5
// glm-5-3, glm-5-3-flash, claude-sonnet-5, claude-opus-5 and gpt-5.6-sol are
// direct Context Arena measurements.

export interface CurveBucket {
  /** Inclusive lower bound, in tokens. */
  lowerBound: number;
  /** Relative retrieval quality at this bucket, 0-1. */
  q: number;
}

export interface ModelCurve {
  /** Matched against the omp model id (substring/regex, case-insensitive). */
  pattern: RegExp;
  /** Ascending by lowerBound, covering 0-16k through 256k-512k. */
  buckets: readonly CurveBucket[];
}

/**
 * Token count where a known model's measured curve ends and the generic
 * fallback-by-window-fraction curve takes over -- the research's "no data ->
 * fallback" / 512k-1M rows.
 */
export const MEASURED_CURVE_CEILING = 512_000;

/** Assumed context window when the model is unknown to omp and reports none. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Order matters: a model whose id matches more than one pattern uses the
 * first match, so a more specific variant (e.g. the "flash" sibling, or the
 * "5.5" point release) is listed before the family it would otherwise also
 * match.
 */
export const MODEL_CURVES: readonly ModelCurve[] = [
  {
    // GLM-5.3-Flash -- direct Context Arena measurement.
    pattern: /glm[-.]?5[-.]?3[-.]?flash/i,
    buckets: [
      { lowerBound: 0, q: 0.85 },
      { lowerBound: 16_000, q: 0.85 },
      { lowerBound: 32_000, q: 0.75 },
      { lowerBound: 64_000, q: 0.6 },
      { lowerBound: 128_000, q: 0.6 },
      { lowerBound: 256_000, q: 0.35 },
    ],
  },
  {
    // GLM-5.3 -- direct Context Arena measurement.
    pattern: /glm[-.]?5[-.]?3/i,
    buckets: [
      { lowerBound: 0, q: 0.95 },
      { lowerBound: 16_000, q: 0.9 },
      { lowerBound: 32_000, q: 0.8 },
      { lowerBound: 64_000, q: 0.65 },
      { lowerBound: 128_000, q: 0.6 },
      { lowerBound: 256_000, q: 0.4 },
    ],
  },
  {
    // Claude Opus 5.5 -- PROXY: Claude Opus 5 (Opus 5.5 has no per-length data;
    // its only reported long-context aggregate, ProgramBench, beats Opus 5's).
    pattern: /opus[-.]?5[-.]?5/i,
    buckets: [
      { lowerBound: 0, q: 1.0 },
      { lowerBound: 16_000, q: 1.0 },
      { lowerBound: 32_000, q: 1.0 },
      { lowerBound: 64_000, q: 0.9 },
      { lowerBound: 128_000, q: 0.65 },
      { lowerBound: 256_000, q: 0.45 },
    ],
  },
  {
    // Claude Opus 5 -- direct Context Arena measurement.
    pattern: /opus[-.]?5/i,
    buckets: [
      { lowerBound: 0, q: 1.0 },
      { lowerBound: 16_000, q: 1.0 },
      { lowerBound: 32_000, q: 1.0 },
      { lowerBound: 64_000, q: 0.9 },
      { lowerBound: 128_000, q: 0.65 },
      { lowerBound: 256_000, q: 0.45 },
    ],
  },
  {
    // Claude Sonnet 5 -- direct Context Arena measurement.
    pattern: /sonnet[-.]?5/i,
    buckets: [
      { lowerBound: 0, q: 1.0 },
      { lowerBound: 16_000, q: 0.9 },
      { lowerBound: 32_000, q: 0.7 },
      { lowerBound: 64_000, q: 0.55 },
      { lowerBound: 128_000, q: 0.55 },
      { lowerBound: 256_000, q: 0.35 },
    ],
  },
  {
    // DeepSeek V4.1 Flash -- PROXY: DeepSeek-V4-Flash-0731 (V4.1-Flash itself
    // has no per-length sweep; only one aggregate LongBench-V2 figure).
    pattern: /deepseek[-.]?v4/i,
    buckets: [
      { lowerBound: 0, q: 0.95 },
      { lowerBound: 16_000, q: 0.8 },
      { lowerBound: 32_000, q: 0.75 },
      { lowerBound: 64_000, q: 0.5 },
      { lowerBound: 128_000, q: 0.4 },
      { lowerBound: 256_000, q: 0.3 },
    ],
  },
  {
    // GPT-6 Sol -- PROXY: GPT-5.6 Sol (GPT-6 Sol itself has no per-length data
    // anywhere). The 256k-512k bucket applies only up to the 400k ai-gw window.
    pattern: /gpt[-.]?6[-.]?sol/i,
    buckets: [
      { lowerBound: 0, q: 1.0 },
      { lowerBound: 16_000, q: 1.0 },
      { lowerBound: 32_000, q: 1.0 },
      { lowerBound: 64_000, q: 0.9 },
      { lowerBound: 128_000, q: 0.85 },
      { lowerBound: 256_000, q: 0.6 },
    ],
  },
  {
    // GPT-5.6 Sol -- direct Context Arena measurement (max reasoning effort).
    pattern: /gpt[-.]?5[-.]?6/i,
    buckets: [
      { lowerBound: 0, q: 1.0 },
      { lowerBound: 16_000, q: 1.0 },
      { lowerBound: 32_000, q: 1.0 },
      { lowerBound: 64_000, q: 0.9 },
      { lowerBound: 128_000, q: 0.85 },
      { lowerBound: 256_000, q: 0.6 },
    ],
  },
];

/**
 * Fallback curve for a model with no Context Arena entry, keyed by fraction
 * of the model's own context window rather than absolute tokens (the
 * research found window-normalizing tracks the measured curves well at the
 * high end). `fractionLowerBound` is inclusive; a fraction past the last
 * bucket keeps its `q` (0.30), matching the research's open-ended "50-100%"
 * bucket. This row set is itself a PROXY for every model it is used on: it is
 * a median over ~100 other models' runs, not a per-model measurement.
 */
export const FALLBACK_FRACTION_CURVE: readonly { fractionLowerBound: number; q: number }[] = [
  { fractionLowerBound: 0, q: 1.0 },
  { fractionLowerBound: 1 / 64, q: 0.95 },
  { fractionLowerBound: 1 / 32, q: 0.8 },
  { fractionLowerBound: 1 / 16, q: 0.65 },
  { fractionLowerBound: 1 / 8, q: 0.55 },
  { fractionLowerBound: 1 / 4, q: 0.4 },
  { fractionLowerBound: 1 / 2, q: 0.3 },
];

/** Finds the highest bucket whose bound (via `boundOf`) `value` has reached. `buckets` must be ascending by that bound and non-empty. */
function findBucket<B>(buckets: readonly B[], value: number, boundOf: (bucket: B) => number): B {
  let result = buckets[0];
  for (const bucket of buckets) {
    if (value >= boundOf(bucket)) result = bucket;
    else break;
  }
  return result;
}

/** Relative quality from the generic fallback curve, at `tokens` against `contextWindow`. */
export function fallbackQuality(tokens: number, contextWindow: number): number {
  const window = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  const fraction = tokens / window;
  return findBucket(FALLBACK_FRACTION_CURVE, fraction, (bucket) => bucket.fractionLowerBound).q;
}

/** First (most specific) `MODEL_CURVES` entry whose pattern matches `modelId`, if any. */
export function resolveModelCurve(modelId: string): ModelCurve | undefined {
  return MODEL_CURVES.find((entry) => entry.pattern.test(modelId));
}

/**
 * Full step curve for `modelId` at `contextWindow`: the model's own measured
 * buckets (through 256k-512k) when recognized, extended past
 * `MEASURED_CURVE_CEILING` with the fallback-by-fraction value at that same
 * window and token count; the full fallback-by-fraction curve, converted to
 * absolute tokens for that window, when the model is unrecognized.
 */
export function curveForModel(modelId: string, contextWindow: number | undefined): readonly CurveBucket[] {
  const window = contextWindow !== undefined && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  const known = resolveModelCurve(modelId);
  if (known) {
    return [
      ...known.buckets,
      { lowerBound: MEASURED_CURVE_CEILING, q: fallbackQuality(MEASURED_CURVE_CEILING, window) },
    ];
  }
  return FALLBACK_FRACTION_CURVE.map((bucket) => ({ lowerBound: bucket.fractionLowerBound * window, q: bucket.q }));
}

/** The bucket covering `tokens` tokens on `curve` (must be non-empty, ascending by lowerBound). */
export function bucketForTokens(curve: readonly CurveBucket[], tokens: number): CurveBucket {
  return findBucket(curve, tokens, (bucket) => bucket.lowerBound);
}
