/** Passively observe scoped terminal forwarding (PRD §5.3). */
import { runContained } from "../core/contained.ts";

type Input = string | Uint8Array;
type Confirm = () => void | Promise<void>;
type Prepare = (input: Input) => Confirm | undefined;

const scopes = new WeakMap<object, Prepare>();

/** Observe at most one write during synchronous dispatch, keyed by the terminal’s xterm. */
export function observeInputWrite<T>(terminal: object, prepare: Prepare, dispatch: () => T): T {
  const prior = scopes.get(terminal);
  scopes.set(terminal, prepare);
  try {
    return dispatch();
  } finally {
    if (prior) scopes.set(terminal, prior);
    else scopes.delete(terminal);
  }
}

export function observedInputWriter(
  terminal: object,
  write: (input: Input) => void,
): (input: Input) => void {
  return (input) => {
    const prepare = scopes.get(terminal);
    let confirm: Confirm | undefined;
    if (prepare) {
      // Consume ownership before invoking any callback that can write reentrantly.
      scopes.delete(terminal);
      runContained(() => {
        confirm = prepare(input);
      });
    }
    write(input);
    if (confirm) {
      const complete = confirm;
      runContained(() => void complete()?.catch(() => undefined));
    }
  };
}
