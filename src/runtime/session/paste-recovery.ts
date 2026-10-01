/** Native submission activity revokes background recovery (PRD §5.3/C-API-31). */
import type { PasteGuard, RecoveryComposer } from "../../core/input/index.ts";
import { captureRenderProgress, subscribeRender } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
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

  /** Share native-frame and ownership captures with every queued paste. */
  createGuard(
    terminal: ElwoodTerminal,
    composer: () => RecoveryComposer,
    blocked: () => boolean,
    beforeEnter: () => void,
  ): PasteGuard {
    return {
      beforeEnter,
      subscribeRender: (listener) => subscribeRender(terminal, listener),
      captureRecovery: () => this.captureRevocationGuard(),
      captureRenderProgress: () => captureRenderProgress(terminal),
      prepareStaged: (payload) => composer().prepareStaged(payload),
      emptyFrame: () => composer().emptyFrame(),
      blocked,
    };
  }

  /** Capture before paste so a hook during the physical Enter cannot be missed. */
  captureRevocationGuard() {
    const generation = this.generation;
    return { revoked: () => generation !== this.generation };
  }
}
