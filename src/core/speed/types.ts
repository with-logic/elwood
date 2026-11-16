/** Adapter-specific speed settings and native evidence. Implements PRD §5.11. */
export type CodexServiceTier = "default" | "fast" | "ultrafast";

/** Cached model support, not live account entitlement or a successful request. */
export type CodexServiceTiers = {
  readonly fetchedAt: string;
  readonly values: readonly CodexServiceTier[];
};

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
  if (value === "default" || value === "fast" || value === "ultrafast") return value;
  return undefined;
}
