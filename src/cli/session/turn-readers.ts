/**
 * Selects the turn readers for the headless CLI's adapter-neutral session facade
 * (PRD §5.8/§12A.5, C-API-57, C-CLI-28).
 *
 * One facade drives BOTH adapters, so it must install the same readers the adapter's own
 * session class uses; otherwise a turn the agent REJECTED is still reported as a successful
 * empty response here — exactly the shape issue #19 reported for `elwood --agent=codex`.
 * The two CLIs report rejection differently: Claude carries it on its `StopFailure` boundary
 * hook, while a rejected Codex turn fires no boundary hook and is evidenced only by a
 * transcript `task_complete` error.
 */

import { claudeBoundarySignal } from "../../claude/turn-failure.ts";
import { codexFailureEvidence } from "../../codex/turn-failure.ts";
import type { TurnReaders } from "../../core/simple/turn-types.ts";
import { defaultBoundarySignal, noFailureEvidence } from "../../core/simple/turn-types.ts";
import type { CliAgent } from "../types.ts";

export function turnReadersFor(agent: CliAgent): TurnReaders {
  return {
    readBoundarySignal: agent === "claude" ? claudeBoundarySignal : defaultBoundarySignal,
    readFailureEvidence: agent === "codex" ? codexFailureEvidence : noFailureEvidence,
  };
}
