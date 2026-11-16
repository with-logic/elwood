/** Codex turn-tier evidence, distinct from provider billing. Implements C-SPEED-03. */
import { isRecord } from "../../core/predicates.ts";
import { type AgentSpeedObservation, codexServiceTier } from "../../core/speed/types.ts";

export function codexSpeedObservation(item: unknown): { readonly speed?: AgentSpeedObservation } {
  if (!isRecord(item) || item["type"] !== "turn_context" || !isRecord(item["payload"])) return {};
  const tier = codexServiceTier(item["payload"]["service_tier"]);
  return tier === undefined
    ? {}
    : { speed: { agent: "codex", serviceTier: tier, evidence: "turn_configuration" } };
}
