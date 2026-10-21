import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  decideHeartbeatNudge,
  hasUserFacingText,
  recordNudgeIssued,
  recordUserFacingSignal,
  resolveThresholdSeconds,
  type HeartbeatState,
} from "./heartbeat-core.ts";

const thresholdMs = resolveThresholdSeconds(process.env.JUST_MY_PI_HEARTBEAT_SECONDS) * 1000;

// Keyed by main-agent id so unrelated main sessions sharing this module (and
// any subagent/advisor sessions that reuse the same factory) never share a
// clock. See "child sessions reuse imported factories ... module-level
// variables remain shared" in the extension-authoring guide.
const statesByAgentId = new Map<string, HeartbeatState>();

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

  // Drop this session's clock when it shuts down so the map doesn't grow
  // unboundedly across many main sessions in a long-lived host process.
  pi.on("session_shutdown", async (_event, ctx) => {
    const main = asMainAgent(ctx);
    if (main) statesByAgentId.delete(main.id);
  });
}
