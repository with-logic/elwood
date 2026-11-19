/** Account quota readings for host dashboards and the CLI (PRD §5.12, C-STATS-03). */
import type { ElwoodAgentKind } from "../activity/index.ts";

export type UsageAccount = {
  readonly agent: ElwoodAgentKind;
  readonly label: string;
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
  readonly checkedAt: string;
  readonly status: "available" | "unavailable";
  readonly windows: readonly UsageWindow[];
};
