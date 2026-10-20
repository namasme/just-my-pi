// Pure decision logic for the heartbeat extension. No pi/omp imports here so
// this file can be unit tested in isolation (see heartbeat-core.test.ts).

/** Default silence budget before nudging the model to update the user. */
export const DEFAULT_HEARTBEAT_SECONDS = 10 * 60;

/**
 * Resolves the heartbeat threshold from an environment variable value,
 * falling back to the default for anything that isn't a positive, finite
 * number of seconds.
 */
export function resolveThresholdSeconds(envValue: string | undefined): number {
  if (envValue === undefined) return DEFAULT_HEARTBEAT_SECONDS;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HEARTBEAT_SECONDS;
  return parsed;
}

/**
 * Per-main-session heartbeat clock.
 *
 * `lastSignalAt` is the timestamp of the last time the user was (or should be
 * considered) "in the loop": either the last assistant message that actually
 * contained user-facing text, or the start of a fresh user turn.
 *
 * `lastNudgeAt` is the timestamp of the last nudge issued since that signal,
 * or `null` if none has been issued yet. It is cleared whenever `lastSignalAt`
 * is updated, so a fresh user-facing signal always earns a full new threshold
 * before the next possible nudge.
 */
export interface HeartbeatState {
  lastSignalAt: number;
  lastNudgeAt: number | null;
}

export function createHeartbeatState(now: number): HeartbeatState {
  return { lastSignalAt: now, lastNudgeAt: null };
}

/** Records a user-facing signal (assistant text, or a fresh user turn starting). */
export function recordUserFacingSignal(now: number): HeartbeatState {
  return { lastSignalAt: now, lastNudgeAt: null };
}

/** Records that a nudge was just issued, without disturbing `lastSignalAt`. */
export function recordNudgeIssued(state: HeartbeatState, now: number): HeartbeatState {
  return { lastSignalAt: state.lastSignalAt, lastNudgeAt: now };
}

export interface HeartbeatDecisionInput {
  now: number;
  thresholdMs: number;
  /** Must already reflect the ctx.agent.kind === "main" (not sub/advisor) check. */
  isMainAgent: boolean;
  state: HeartbeatState;
}

/**
 * Pure decision: should a heartbeat nudge be injected right now?
 *
 * Returns the hint text, or `undefined` when no nudge is due. Never mutates
 * `input.state`; callers apply `recordNudgeIssued` themselves when a hint is
 * returned.
 */
export function decideHeartbeatNudge(input: HeartbeatDecisionInput): string | undefined {
  const { now, thresholdMs, isMainAgent, state } = input;
  if (!isMainAgent) return undefined;

  const elapsedSinceSignal = now - state.lastSignalAt;
  if (elapsedSinceSignal < thresholdMs) return undefined;

  if (state.lastNudgeAt !== null && now - state.lastNudgeAt < thresholdMs) return undefined;

  const minutes = Math.max(1, Math.round(elapsedSinceSignal / 60_000));
  return buildHeartbeatHint(minutes);
}

export function buildHeartbeatHint(minutes: number): string {
  const unit = minutes === 1 ? "minute" : "minutes";
  return (
    `You have not updated the user in ${minutes} ${unit}. Before your next tool call, send one short line: ` +
    "what you're doing, what (if anything) is blocking, and roughly how much is left. Then continue."
  );
}

/** Minimal shape of an assistant message content block, for text detection. */
export interface AssistantContentBlockLike {
  type: string;
  text?: unknown;
}

/**
 * True when the given assistant message content includes at least one
 * non-empty text block (thinking blocks, tool-call blocks, and blank/
 * whitespace-only text do not count as "told the user something").
 */
export function hasUserFacingText(content: readonly AssistantContentBlockLike[] | null | undefined): boolean {
  if (!content) return false;
  return content.some(
    (block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
  );
}
