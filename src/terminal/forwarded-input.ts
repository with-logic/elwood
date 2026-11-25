/** Passively observe scoped terminal forwarding (PRD §5.3). */
import { runContained } from "../core/contained.ts";
import type { XtermTerminal } from "./headless.ts";

type Input = string | Uint8Array;
type Confirm = () => void | Promise<void>;
type Prepare = (input: Input) => Confirm | undefined;

const scopes = new WeakMap<XtermTerminal, Prepare>();

/** Prepare on the first synchronous forwarding. The dispatch result is returned unchanged. */
export function observeInputWrite<T>(xterm: XtermTerminal, prepare: Prepare, dispatch: () => T): T {
  const prior = scopes.get(xterm);
  scopes.set(xterm, prepare);
  try {
    return dispatch();
  } finally {
    if (prior) scopes.set(xterm, prior);
    else scopes.delete(xterm);
  }
}

/** Confirm after a successful write. Writer errors propagate, and observer work is contained. */
export function observedInputWriter(
  xterm: XtermTerminal,
  write: (input: Input) => void,
): (input: Input) => void {
  return (input) => {
    const prepare = scopes.get(xterm);
    let confirm: Confirm | undefined;
    if (prepare) {
      // Consume ownership before invoking any callback that can write reentrantly.
      scopes.delete(xterm);
      runContained(() => {
        // Pass a copy even for Buffer inputs, where slice would retain the same bytes.
        confirm = prepare(typeof input === "string" ? input : Uint8Array.from(input));
      });
    }
    write(input);
    if (confirm) {
      const complete = confirm;
      // A returned promise belongs to the observer and never holds the terminal write.
      runContained(() => void complete()?.catch(() => undefined));
    }
  };
}
