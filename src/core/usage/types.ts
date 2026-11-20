/** Account quota readings for host dashboards (PRD §5.12, C-STATS-03). */
import type { ElwoodAgentKind } from "../activity/index.ts";

export type UsageAccount = {
  readonly agent: ElwoodAgentKind;
  readonly label: string;
  /** Absolute directory holding this native CLI profile's sign-in. */
  readonly configDir?: string;
};

export type UsageWindow = {
  readonly label: string;
  readonly windowMinutes?: number;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly resetsAt?: string;
};

export type AccountUsage = {
  readonly agent: ElwoodAgentKind;
  readonly label: string;
  /** ISO timestamp when the profile read finished. */
  readonly checkedAt: string;
} & (
  | { readonly status: "available"; readonly windows: readonly [UsageWindow, ...UsageWindow[]] }
  | { readonly status: "unavailable"; readonly windows: readonly [] }
);
