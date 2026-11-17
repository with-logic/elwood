/** Adapter-specific speed settings and native evidence. Implements PRD §5.11. */
export const codexServiceTiers = ["default", "fast", "ultrafast"] as const;
export type CodexServiceTier = (typeof codexServiceTiers)[number];

/** Elwood supplies `default`; additional tiers come from valid cache evidence, not live entitlement. */
export type CodexServiceTiers = {
  readonly fetchedAt: string;
  readonly values: readonly ["default", ...CodexServiceTier[]];
};

/**
 * Evidence for one transcript record, not the session's current setting.
 * Codex reports turn configuration, not provider-billed speed; Claude reports
 * assistant-response usage. Consumers retain the event's transcript ownership.
 */
export type AgentSpeedObservation =
  | {
      readonly agent: "codex";
      readonly serviceTier: CodexServiceTier;
      readonly evidence: "turn_configuration";
    }
  | { readonly agent: "claude"; readonly fastMode: boolean; readonly evidence: "response_usage" };

/** Native `priority` and `fast` name the same tier; unknown never means standard. */
export function codexServiceTier(value: unknown): CodexServiceTier | undefined {
  if (value === "priority") return "fast";
  return codexServiceTiers.find((tier) => tier === value);
}
