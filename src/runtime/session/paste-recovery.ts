/** Native observations revoke recovery independently of cleanup ownership (PRD §5.3). */
import type { SessionStatusEmitter } from "./status-wiring.ts";

export class PasteRecoveryRevocation {
  private generation = 0;
  private working = false;

  constructor(events: SessionStatusEmitter, closing: AbortSignal) {
    const unsubscribe = events.on("activity", (event) => {
      // This is conservative revocation, not proof of prompt/turn correlation.
      if (event.kind === "user_message") this.generation += 1;
    });
    closing.addEventListener("abort", unsubscribe, { once: true });
  }

  observeWorking(working: boolean): void {
    if (working && !this.working) this.generation += 1;
    this.working = working;
  }

  captureRevocationGuard() {
    const generation = this.generation;
    const working = this.working;
    return {
      revoked: () => working || generation !== this.generation,
    };
  }
}
