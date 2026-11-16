/** Claude response speed is evidence only when native usage reports it. Implements C-SPEED-03. */
import { isRecord } from "../../core/predicates.ts";
import type { AgentSpeedObservation } from "../../core/speed/types.ts";

export function claudeSpeedObservation(item: unknown): { readonly speed?: AgentSpeedObservation } {
  if (!isRecord(item) || item["type"] !== "assistant") return {};
  const message = item["message"];
  if (!(isRecord(message) && isRecord(message["usage"]))) return {};
  const speed = message["usage"]["speed"];
  return speed === "fast" || speed === "standard"
    ? { speed: { agent: "claude", fastMode: speed === "fast", evidence: "response_usage" } }
    : {};
}
