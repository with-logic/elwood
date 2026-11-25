/** Track host terminal mutations that invalidate native dialog evidence (C-TRUST-01). */
import type { Terminal } from "@xterm/headless";

type InvalidationListener = () => void | Promise<void>;

export class NativeRenderEvidence {
  private readonly listeners = new Set<InvalidationListener>();
  private nextWriteFromPty = false;
  private valid = true;

  get intact(): boolean {
    return this.valid;
  }

  subscribe(listener: InvalidationListener): () => void {
    if (!this.valid) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  invalidate(): void {
    if (!this.valid) return;
    this.valid = false;
    for (const listener of this.listeners) {
      // Let the triggering mutation finish before observers can write again.
      void Promise.resolve()
        .then(() => {
          if (this.listeners.delete(listener)) return listener();
        })
        .catch(() => undefined);
    }
  }

  /** A one-use marker consumed by the synchronous xterm dispatch. */
  withPtyOutputWrite<T>(dispatch: () => T): T {
    this.nextWriteFromPty = true;
    try {
      return dispatch();
    } finally {
      this.nextWriteFromPty = false;
    }
  }

  observeMutation(): void {
    if (!this.nextWriteFromPty) this.invalidate();
    this.nextWriteFromPty = false;
  }
}

/** Raw xterm mutations bypass owned revisions and must invalidate cached rows. */
export function trackRenderMutations(
  terminal: Terminal,
  invalidate: () => void,
  mutation: () => void,
): () => void {
  const restore: Array<() => void> = [];
  const writes: readonly ("write" | "writeln")[] = ["write", "writeln"];
  for (const method of writes) {
    const original = terminal[method];
    const write = original.bind(terminal);
    terminal[method] = (data, callback) => {
      // writeln can parse its first internal write synchronously after user input.
      invalidate();
      mutation();
      write(data, () => {
        invalidate();
        callback?.();
      });
    };
    restore.push(() => {
      terminal[method] = original;
    });
  }
  for (const method of ["clear", "reset", "dispose"] as const) {
    const original = terminal[method];
    terminal[method] = () => {
      mutation();
      original.call(terminal);
      invalidate();
    };
    restore.push(() => {
      terminal[method] = original;
    });
  }
  return () => {
    for (const method of restore) method();
  };
}
