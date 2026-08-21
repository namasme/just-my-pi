import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// bash `timeout` is in seconds. Enforce presence + an upper bound of 2 hours.
const MAX_TIMEOUT_SECONDS = 2 * 60 * 60; // 7200

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return;

    const { timeout } = event.input; // { command: string; timeout?: number }

    // Must be present and a real, positive number (not empty/nil/NaN/0).
    if (
      timeout === undefined ||
      timeout === null ||
      typeof timeout !== "number" ||
      !Number.isFinite(timeout) ||
      timeout <= 0
    ) {
      return {
        block: true,
        reason:
          "Every bash call must set an explicit positive `timeout` (in seconds). " +
          `Re-issue the command with a timeout > 0 and <= ${MAX_TIMEOUT_SECONDS} (2 hours).`,
      };
    }

    // Enforce the upper bound of 2 hours.
    if (timeout > MAX_TIMEOUT_SECONDS) {
      return {
        block: true,
        reason: `bash \`timeout\` must be <= ${MAX_TIMEOUT_SECONDS} seconds (2 hours). You requested ${timeout}.`,
      };
    }
  });
}
