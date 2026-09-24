/** Native observations revoke recovery independently of cleanup ownership (PRD §5.3). */
import { quietFramesToSettle } from "../../core/turn-state.ts";
import type { SessionStatusEmitter } from "./status-wiring.ts";

export class PasteRecoveryRevocation {
  private generation = 0;
  private working = false;
  private settlingAfterStop = false;
  private quietStreak = 0;

  constructor(events: SessionStatusEmitter, closing: AbortSignal) {
    const unsubscribe = events.on("activity", (event) => {
      // This is conservative revocation, not proof of prompt/turn correlation.
      if (event.kind === "user_message") this.generation += 1;
    });
    closing.addEventListener("abort", unsubscribe, { once: true });
  }

  /** Stop may precede stale working repaints; require quiet settlement to re-arm. */
  completeTurn(): void {
    this.working = false;
    this.settlingAfterStop = true;
    this.quietStreak = 0;
  }

  observeWorking(working: boolean, quiet: boolean): void {
    if (this.settlingAfterStop) {
      this.quietStreak = quiet ? this.quietStreak + 1 : 0;
      if (this.quietStreak < quietFramesToSettle) return;
      this.settlingAfterStop = false;
    }
    if (working && !this.working) this.generation += 1;
    this.working = working;
  }

  /** Capture before paste/Enter: active work stays revoked even after idle; later
   * native evidence is detected through the live generation comparison. */
  captureRevocationGuard() {
    const generation = this.generation;
    const working = this.working;
    return {
      revoked: () => working || generation !== this.generation,
    };
  }
}
