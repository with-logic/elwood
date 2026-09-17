/**
 * Reports the session's own terminal writes so startup-only recognition can end
 * the moment caller content can reach the screen. Implements PRD §5.7 / C-API-14.
 */
import type { ElwoodTerminal } from "../../terminal/headless.ts";

/** Startup automation keeps writing through `inner`; only the session's view notifies. */
export function reportCallerInput(inner: ElwoodTerminal, onInput: () => void): ElwoodTerminal {
  return {
    get xterm() {
      return inner.xterm;
    },
    get size() {
      return inner.size;
    },
    get title() {
      return inner.title;
    },
    writeOutput: (...args) => inner.writeOutput(...args),
    sendInput: (input) => {
      onInput();
      return inner.sendInput(input);
    },
    resize: (size) => inner.resize(size),
    snapshot: () => inner.snapshot(),
    settled: () => inner.settled(),
    dispose: () => inner.dispose(),
  };
}
