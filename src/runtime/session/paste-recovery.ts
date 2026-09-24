/** Native observations revoke recovery independently of cleanup ownership (PRD §5.3). */
import type { RecoveryObservation } from "../../core/input/recovery.ts";
import { currentRenderGeneration } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import type { SessionStatusEmitter } from "./status-wiring.ts";

export class NativePasteRecovery {
  private generation: object = {};
  private working = false;
  private readonly terminal: ElwoodTerminal;

  constructor(terminal: ElwoodTerminal, events: SessionStatusEmitter, closing: AbortSignal) {
    this.terminal = terminal;
    const unsubscribe = events.on("activity", (event) => {
      // This is conservative revocation, not proof of prompt/turn correlation.
      if (event.kind === "user_message") this.generation = {};
    });
    closing.addEventListener("abort", unsubscribe, { once: true });
  }

  observeWorking(working: boolean): void {
    this.working = working;
    if (working) this.generation = {};
  }

  capture(): RecoveryObservation {
    const generation = this.generation;
    const working = this.working;
    return {
      revoked: () => working || generation !== this.generation,
      frame: () => currentRenderGeneration(this.terminal),
    };
  }
}
