/** The native input controls read live screen rows (PRD §5.3). */
import type { ObservedTerminal } from "../../core/input/abort.ts";
import { renderedSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";

export function liveInputTerminal(terminal: ElwoodTerminal): ObservedTerminal {
  return {
    sendInput: (input) => terminal.sendInput(input),
    settled: () => terminal.settled(),
    get renderFailed() {
      return terminal.renderFailed;
    },
    snapshot: () => renderedSnapshot(terminal, "live"),
  };
}
