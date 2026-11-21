/** Public session stats snapshots (PRD §5.12, C-STATS-04). */
import type { ElwoodSessionStatus } from "../types.ts";
import type { UsageWindows } from "../usage/types.ts";
import type { ClaudeTokenUsage, CodexTokenUsage } from "./types.ts";

export type QuotaSnapshot =
  | { readonly state: "unavailable" }
  | {
      readonly state: "fresh" | "stale";
      readonly observedAt: string;
      readonly windows: UsageWindows;
    };

export type SessionStats = {
  readonly status: ElwoodSessionStatus;
  readonly latestTokenUsage?: {
    readonly transcriptPath: string;
    readonly usage: ClaudeTokenUsage | CodexTokenUsage;
  };
  readonly activeSubagentCount: number;
  readonly quota: QuotaSnapshot;
};

export interface StatsControls {
  getStats(): Promise<SessionStats>;
}

export function emptySessionStats(status: ElwoodSessionStatus): SessionStats {
  return { status, activeSubagentCount: 0, quota: { state: "unavailable" } };
}
