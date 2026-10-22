import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  decideHeartbeatNudge,
  hasUserFacingText,
  recordNudgeIssued,
  recordUserFacingSignal,
  resolveThresholdSeconds,
  type HeartbeatState,
} from "./heartbeat-core.ts";
import {
  computeWidgetLines,
  createStatusState,
  endLoop,
  extractUserFacingText,
  recordAssistantText,
  recordToolResult,
  resetTurn,
  resolveStatusDelaySeconds,
  resolveWidgetWidth,
  startLoop,
  type StatusState,
} from "./status-core.ts";

const thresholdMs = resolveThresholdSeconds(process.env.JUST_MY_PI_HEARTBEAT_SECONDS) * 1000;

// Keyed by main-agent id so unrelated main sessions sharing this module (and
// any subagent/advisor sessions that reuse the same factory) never share a
// clock. See "child sessions reuse imported factories ... module-level
// variables remain shared" in the extension-authoring guide.
const statesByAgentId = new Map<string, HeartbeatState>();

// --- Pinned status widget ("Latest from agent") -----------------------------
//
// Pins the main agent's most recent user-facing text above the editor once a
// turn runs long, so it stays visible without scrolling back through a deep
// tool-call chain. All decision/formatting logic lives in status-core.ts;
// this section only wires it to lifecycle events and `ctx.ui.setWidget`.

const STATUS_WIDGET_KEY = "just-my-pi-status";
const STATUS_REFRESH_INTERVAL_MS = 15_000;
const statusDisabled = process.env.JUST_MY_PI_STATUS_DISABLE === "1";
const statusDelayMs = resolveStatusDelaySeconds(process.env.JUST_MY_PI_STATUS_DELAY_SECONDS) * 1000;

// Keyed by main-agent id, same rationale as statesByAgentId above.
const statusStatesByAgentId = new Map<string, StatusState>();
// The handle returned by ctx.setInterval for each main session's 15s refresh
// tick, so it can be cleared on agent_end/session_shutdown.
const statusTimersByAgentId = new Map<string, unknown>();

/**
 * Structural shape we need from `ctx` for the widget. omp documents `ui`,
 * `hasUI`, `setInterval`, and `clearTimer` on its `ExtensionContext`, but the
 * plain-pi package this extension also compiles against doesn't declare
 * them — narrowed to exactly what's used and made optional, same approach as
 * `AgentFieldCarrier` below, so a plain-pi ctx (missing all of these) is
 * still structurally assignable and the widget calls simply no-op.
 */
interface WidgetContextCarrier {
  hasUI?: boolean;
  ui?: {
    setWidget?: (
      key: string,
      content: string[] | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ) => void;
  };
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Recomputes and pushes the widget's current content (or hides it) for one main session. */
function renderStatusWidget(agentId: string, ctx: WidgetContextCarrier): void {
  if (!ctx.hasUI) return; // print mode / --no-ui: no-op
  const state = statusStatesByAgentId.get(agentId);
  const lines = state
    ? computeWidgetLines(state, Date.now(), {
        delayMs: statusDelayMs,
        width: resolveWidgetWidth(process.stdout.columns),
      })
    : undefined;
  ctx.ui?.setWidget?.(STATUS_WIDGET_KEY, lines, { placement: "aboveEditor" });
}

interface MainAgentHandle {
  id: string;
}

/** Structural shape we need from `ctx`; real `ExtensionContext` types are a superset. */
interface AgentFieldCarrier {
  agent?: unknown;
}

/**
 * `ctx.agent` (kind/id) is documented for omp's ExtensionContext but may not
 * exist on plain pi (`@earendil-works/pi-coding-agent` without the omp
 * runtime). Treat a missing/ambiguous shape as "can't prove this is the main
 * session" and no-op rather than guessing — this extension only ever acts on
 * the main agent.
 */
function asMainAgent(ctx: AgentFieldCarrier): MainAgentHandle | undefined {
  const { agent } = ctx;
  if (!agent || typeof agent !== "object") return undefined;
  if (!("kind" in agent) || agent.kind !== "main") return undefined;
  if (!("id" in agent) || typeof agent.id !== "string") return undefined;
  return { id: agent.id };
}

function resetClock(agentId: string, now: number): void {
  statesByAgentId.set(agentId, recordUserFacingSignal(now));
}

export default function heartbeat(pi: ExtensionAPI) {
  // A fresh user prompt (including steers and queued follow-up batches)
  // starts a fresh clock: the model hasn't had a chance to go silent yet.
  // Fires in print/ACP too, unlike `input`, and is a documented event in
  // both pi and omp's event unions, so it stays a no-op under plain pi via
  // `asMainAgent` alone (no `ctx.agent` there).
  pi.on("before_agent_start", async (_event, ctx) => {
    const main = asMainAgent(ctx);
    if (!main) return;
    resetClock(main.id, Date.now());
  });

  // Track the last time the assistant actually said something to the user
  // (text blocks only — thinking/tool-call-only messages don't count).
  pi.on("assistant_message", async (event, ctx) => {
    const main = asMainAgent(ctx);
    if (!main) return;
    if (!hasUserFacingText(event.message.content)) return;
    resetClock(main.id, Date.now());
  });

  // On every tool result in the main session, nudge the model if it's been
  // silent too long and hasn't already been nudged since its last update.
  pi.on("tool_result", async (_event, ctx) => {
    const main = asMainAgent(ctx);
    if (!main) return;

    const now = Date.now();
    let state = statesByAgentId.get(main.id);
    if (!state) {
      // First observation of this session: start the clock now rather than
      // assuming a silence that predates our own registration.
      resetClock(main.id, now);
      return;
    }

    const hint = decideHeartbeatNudge({ now, thresholdMs, isMainAgent: true, state });
    if (!hint) return;

    state = recordNudgeIssued(state, now);
    statesByAgentId.set(main.id, state);
    return { additionalContext: hint };
  });

  if (!statusDisabled) {
    // A fresh prompt or steer starts a new turn: clear any update shown for
    // the previous one right away, so a steer mid-tool-call-storm doesn't
    // leave stale text pinned.
    pi.on("before_agent_start", async (_event, ctx) => {
      const main = asMainAgent(ctx);
      if (!main) return;
      const now = Date.now();
      statusStatesByAgentId.set(main.id, resetTurn(now, statusStatesByAgentId.get(main.id)));
      renderStatusWidget(main.id, ctx);
    });

    // The agent loop started: the widget may appear once its delay elapses.
    // (Re)start the 15s refresh tick so age/elapsed stay current during a
    // single long tool call.
    pi.on("agent_start", async (_event, ctx) => {
      const main = asMainAgent(ctx);
      if (!main) return;
      const now = Date.now();
      statusStatesByAgentId.set(main.id, startLoop(statusStatesByAgentId.get(main.id) ?? createStatusState(now)));

      const existingTimer = statusTimersByAgentId.get(main.id);
      if (existingTimer !== undefined) ctx.clearTimer?.(existingTimer);
      const timer = ctx.setInterval?.(() => renderStatusWidget(main.id, ctx), STATUS_REFRESH_INTERVAL_MS);
      if (timer !== undefined) statusTimersByAgentId.set(main.id, timer);

      renderStatusWidget(main.id, ctx);
    });

    // Track the assistant's latest user-facing text this turn.
    pi.on("assistant_message", async (event, ctx) => {
      const main = asMainAgent(ctx);
      if (!main) return;
      const now = Date.now();
      let state = statusStatesByAgentId.get(main.id) ?? createStatusState(now);
      if (hasUserFacingText(event.message.content)) {
        state = recordAssistantText(state, now, extractUserFacingText(event.message.content));
      }
      statusStatesByAgentId.set(main.id, state);
      renderStatusWidget(main.id, ctx);
    });

    // Count tool calls since the last update, and refresh the widget so a
    // storm of calls keeps the header's "ago"/"since" numbers current.
    pi.on("tool_result", async (_event, ctx) => {
      const main = asMainAgent(ctx);
      if (!main) return;
      const state = statusStatesByAgentId.get(main.id) ?? createStatusState(Date.now());
      statusStatesByAgentId.set(main.id, recordToolResult(state));
      renderStatusWidget(main.id, ctx);
    });

    // The agent loop ended: hide the widget (the final answer is then the
    // last chat item) and stop the refresh tick.
    pi.on("agent_end", async (_event, ctx) => {
      const main = asMainAgent(ctx);
      if (!main) return;
      const state = statusStatesByAgentId.get(main.id);
      if (state) statusStatesByAgentId.set(main.id, endLoop(state));

      const timer = statusTimersByAgentId.get(main.id);
      if (timer !== undefined) {
        ctx.clearTimer?.(timer);
        statusTimersByAgentId.delete(main.id);
      }

      renderStatusWidget(main.id, ctx);
    });
  }

  // Drop this session's state when it shuts down so the maps don't grow
  // unboundedly across many main sessions in a long-lived host process, and
  // explicitly remove the widget (belt-and-suspenders alongside agent_end).
  pi.on("session_shutdown", async (_event, ctx) => {
    const main = asMainAgent(ctx);
    if (!main) return;
    statesByAgentId.delete(main.id);

    if (!statusDisabled) {
      const timer = statusTimersByAgentId.get(main.id);
      if (timer !== undefined) ctx.clearTimer?.(timer);
      statusTimersByAgentId.delete(main.id);
      statusStatesByAgentId.delete(main.id);
      ctx.ui?.setWidget?.(STATUS_WIDGET_KEY, undefined);
    }
  });
}
