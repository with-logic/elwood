/** Project in-memory session observations for the dashboard API (PRD §5.12, C-STATS-04). */
import type { ElwoodActivityEvent, ElwoodAgentKind } from "../../core/activity/index.ts";
import { optional } from "../../core/optional.ts";
import type { QuotaSnapshot, SessionStats } from "../../core/stats/snapshot-types.ts";
import type { TerminalReplayBuffer } from "../../core/terminal-replay.ts";
import { type UsageDeadline, usageDeadline, usageIsFresh } from "../../core/usage/freshness.ts";
import type { UsageWindows } from "../../core/usage/types.ts";
import type { PtyProcess } from "../../pty/types.ts";
import type { PersistedLoopDefinition } from "../../state/loop-store.ts";
import type { SessionRuntime } from "../../state/runtime-paths.ts";
import type { SessionRecord } from "../../state/store.ts";
import { SessionLifecycle } from "./lifecycle.ts";
import type { SessionInputOwnership } from "./session-input.ts";
import type { SessionStatusEmitter } from "./status-wiring.ts";

export abstract class SessionStatsReader extends SessionLifecycle {
  private readonly subagents = new Set<string>();
  private latestTokenUsage: SessionStats["latestTokenUsage"];
  private quota:
    | {
        readonly observedAtMs: number;
        readonly windows: UsageWindows;
        readonly deadline: UsageDeadline;
      }
    | undefined;

  protected constructor(
    agent: ElwoodAgentKind,
    record: SessionRecord,
    stateDir: string,
    runtime: SessionRuntime,
    pty: PtyProcess,
    input: SessionInputOwnership,
    events: SessionStatusEmitter,
    replay: TerminalReplayBuffer,
    loops: readonly PersistedLoopDefinition[],
  ) {
    super(agent, record, stateDir, runtime, pty, input, events, replay, loops);
    events.on("activity", (event) => this.observeStats(event));
    events.on("terminal:exit", () => this.subagents.clear());
  }

  observeQuota(windows: UsageWindows, observedAtMs: number): void {
    if (this.quota && observedAtMs < this.quota.observedAtMs) return;
    this.quota = { observedAtMs, windows, deadline: usageDeadline(observedAtMs, windows) };
  }

  getStats(): Promise<SessionStats> {
    return Promise.resolve({
      status: this.status,
      activeSubagentCount: this.subagents.size,
      ...optional(structuredClone(this.latestTokenUsage), "latestTokenUsage"),
      quota: this.readQuota(),
    });
  }

  private readQuota(): QuotaSnapshot {
    if (this.quota === undefined) return { state: "unavailable" };
    const { observedAtMs, windows, deadline } = this.quota;
    return {
      state: usageIsFresh(deadline) ? "fresh" : "stale",
      observedAt: new Date(observedAtMs).toISOString(),
      windows: structuredClone(windows),
    };
  }

  private observeStats(event: ElwoodActivityEvent): void {
    if (event.tokenUsage) {
      this.latestTokenUsage = structuredClone({
        transcriptPath: event.transcriptPath,
        usage: event.tokenUsage,
      });
    }
    if (event.subagent) {
      const { id, state } = event.subagent;
      if (state === "started") this.subagents.add(id);
      else this.subagents.delete(id);
    }
  }
}
