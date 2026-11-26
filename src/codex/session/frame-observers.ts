/** Build the observers that classify Codex PTY frames (PRD §5.4 and §5.7). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { AttentionWatcher } from "../../core/attention.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { TurnStateWatcher } from "../../core/turn-state.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import type { TerminalSnapshot } from "../../terminal/headless.ts";
import { codexScreenFactTableForTrustPolicy } from "../screen-table.ts";
import type { CodexEventMap } from "./types.ts";

export function codexFrameObservers(
  emitter: TypedEmitter<CodexEventMap>,
  elwoodSessionId: string,
  autotrust: boolean,
  clearance: TrustClearance,
  snapshot: () => TerminalSnapshot,
) {
  return {
    turn: new TurnStateWatcher(),
    attention: new AttentionWatcher(),
    table: codexScreenFactTableForTrustPolicy(autotrust, clearance, snapshot),
    agent: "codex" as const,
    elwoodSessionId,
    emitActivity: (event: ElwoodActivityEvent) => emitter.emit("activity", event),
    warnings: emitter,
  };
}
