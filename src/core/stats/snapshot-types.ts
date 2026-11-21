/** Public session stats snapshots (PRD §5.12, C-STATS-04). */
import type { ElwoodSessionStatus } from "../types.ts";
import type { UsageWindows } from "../usage/types.ts";
import type { ClaudeTokenUsage, CodexTokenUsage } from "./types.ts";

export type QuotaSnapshot =
  | { readonly state: "unavailable" }
  | {
      readonly state: "fresh" | "stale";
      /** ISO transcript timestamp, or receipt time when the timestamp is missing or in the future. */
      readonly observedAt: string;
      readonly windows: UsageWindows;
    };

export type SessionStats = {
  readonly status: ElwoodSessionStatus;
  readonly latestTokenUsage?: {
    readonly transcriptPath: string;
    readonly usage: ClaudeTokenUsage | CodexTokenUsage;
  };
  /** Best-effort count of active subagents observed through hooks. */
  readonly activeSubagentCount: number;
  readonly quota: QuotaSnapshot;
};

export interface StatsControls {
  /** Read the latest in-memory stats without polling or starting a session. */
  getStats(): Promise<SessionStats>;
}

export function emptySessionStats(status: ElwoodSessionStatus): SessionStats {
  return { status, activeSubagentCount: 0, quota: { state: "unavailable" } };
}
