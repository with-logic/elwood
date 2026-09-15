/** Keep SIGINT bound between combined probes and replay cancellation at launch (PRD §12A.10). */
import type { Unsubscribe } from "../../core/types.ts";
import type { CliSignalSource } from "../lifecycle/index.ts";

export class ModelsSignals implements CliSignalSource {
  interrupted = false;
  private readonly handlers = new Set<() => void>();
  readonly dispose: Unsubscribe;

  constructor(source: CliSignalSource) {
    this.dispose = source.onSigint(() => {
      this.interrupted = true;
      for (const handler of this.handlers) handler();
    });
  }

  onSigint(handler: () => void): Unsubscribe {
    this.handlers.add(handler);
    if (this.interrupted) handler();
    return () => {
      this.handlers.delete(handler);
    };
  }
}
