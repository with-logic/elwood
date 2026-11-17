/** Adapter-specific speed settings and accepted tiers. Implements PRD §5.11. */
export const codexServiceTiers = ["default", "fast", "ultrafast"] as const;
export type CodexServiceTier = (typeof codexServiceTiers)[number];

/** Native `priority` and `fast` name the same tier; unknown never means standard. */
export function codexServiceTier(value: unknown): CodexServiceTier | undefined {
  if (value === "priority") return "fast";
  return codexServiceTiers.find((tier) => tier === value);
}
