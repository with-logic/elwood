/** Track host terminal mutations that invalidate native dialog evidence (C-TRUST-01). */
import type { Terminal } from "@xterm/headless";

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
