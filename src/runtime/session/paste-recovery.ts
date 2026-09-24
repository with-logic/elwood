/** Native submission activity revokes background recovery (PRD §5.3/C-API-31). */
import type { SessionStatusEmitter } from "./status-wiring.ts";

export class PasteRecoveryRevocation {
  private generation = 0;

  constructor(events: SessionStatusEmitter, closing: AbortSignal) {
    const unsubscribe = events.on("activity", (event) => {
      // Conservative revocation, not proof of prompt/turn correlation.
      if (event.kind === "user_message") this.generation += 1;
    });
    closing.addEventListener("abort", unsubscribe, { once: true });
  }

  /** Capture before paste so a hook during the physical Enter cannot be missed. */
  captureRevocationGuard() {
    const generation = this.generation;
    return { revoked: () => generation !== this.generation };
  }
}
