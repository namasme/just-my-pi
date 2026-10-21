import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildDelegationHint,
  createDelegationState,
  decideDelegationNudge,
  isDisabledByEnv,
  isForcedByEnv,
  resolveNudgeDelivery,
  resolveTokensScale,
  type DelegationNudge,
  type DelegationState,
} from "./delegation-core.ts";

const disabled = isDisabledByEnv(process.env.JUST_MY_PI_DELEGATION_DISABLE);
const forced = isForcedByEnv(process.env.JUST_MY_PI_DELEGATION_FORCE);
// Test-only: multiplies observed tokens before bucket lookup, so a cheap
// smoke-test prompt can reach a q < 0.95 bucket without filling the context
// window. Never set this outside a smoke test.
const tokensScale = resolveTokensScale(process.env.JUST_MY_PI_DELEGATION_TOKENS_SCALE);

// Keyed by main-agent id so unrelated main sessions sharing this module (and
// any subagent/advisor sessions that reuse the same factory) never share a
// watermark. See "child sessions reuse imported factories ... module-level
// variables remain shared" in the extension-authoring guide.
const statesByAgentId = new Map<string, DelegationState>();

// Fallback signal for when ctx.getContextUsage() is unavailable (plain pi)
// or reports no tokens yet (right after compaction, before the next LLM
// response): the last assistant message's own usage.
const lastUsageTokensByAgentId = new Map<string, number>();

// A tool batch can span several tool_result events as context keeps growing
// within it; this latch caps delivery to at most one nudge per batch. It is
// cleared on each assistant_message (one per tool batch) so the next batch
// can nudge again.
const nudgedThisBatchByAgentId = new Set<string>();

// A winning sample blocked by the latch is deferred here and delivered at the
// next tool_result once the latch clears (see resolveNudgeDelivery).
const pendingNudgeByAgentId = new Map<string, DelegationNudge>();

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

export default function delegationNudge(pi: ExtensionAPI) {
  if (disabled) return;

  // Track the last assistant response's own usage as a fallback signal, in
  // case ctx.getContextUsage() is unavailable or momentarily reports no
  // tokens (e.g. immediately after compaction, before the next response).
  pi.on("assistant_message", async (event, ctx) => {
    const main = asMainAgent(ctx);
    if (!main) return;
    nudgedThisBatchByAgentId.delete(main.id);
    const usage = event.message.usage;
    if (!usage) return;
    lastUsageTokensByAgentId.set(main.id, usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
  });

  // On every tool result in the main session, check whether context has
  // grown into a new quality bucket for the current model and, if so,
  // sample once for a delegation nudge.
  pi.on("tool_result", async (_event, ctx) => {
    const main = asMainAgent(ctx);
    if (!main) return;

    const modelId = ctx.model?.id;
    if (typeof modelId !== "string") return;

    const usage = ctx.getContextUsage?.();
    let tokens: number | undefined;
    let contextWindow: number | undefined;
    if (usage && usage.tokens !== null) {
      tokens = usage.tokens;
      contextWindow = usage.contextWindow;
    } else {
      tokens = lastUsageTokensByAgentId.get(main.id);
      contextWindow = ctx.model?.contextWindow;
    }
    if (tokens === undefined) return; // nothing observed yet this session

    const state = statesByAgentId.get(main.id) ?? createDelegationState();
    const decision = decideDelegationNudge({
      tokens: tokens * tokensScale,
      modelId,
      contextWindow,
      state,
      rng: Math.random,
      force: forced,
    });
    statesByAgentId.set(main.id, decision.state);

    const delivery = resolveNudgeDelivery({
      sampled: decision.nudge,
      pending: pendingNudgeByAgentId.get(main.id),
      deliveredThisBatch: nudgedThisBatchByAgentId.has(main.id),
      contextReset: decision.contextReset === true,
      modelId,
    });
    if (delivery.pending) pendingNudgeByAgentId.set(main.id, delivery.pending);
    else pendingNudgeByAgentId.delete(main.id);
    if (!delivery.deliver) return;

    nudgedThisBatchByAgentId.add(main.id);
    return { additionalContext: buildDelegationHint(delivery.deliver.tokens, delivery.deliver.modelId, delivery.deliver.q) };
  });

  // Drop this session's watermark/usage when it shuts down so the maps
  // don't grow unboundedly across many main sessions in a long-lived host
  // process.
  pi.on("session_shutdown", async (_event, ctx) => {
    const main = asMainAgent(ctx);
    if (!main) return;
    statesByAgentId.delete(main.id);
    lastUsageTokensByAgentId.delete(main.id);
    nudgedThisBatchByAgentId.delete(main.id);
    pendingNudgeByAgentId.delete(main.id);
  });
}
