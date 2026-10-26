/**
 * Records what a real PTY spawned by an e2e session received and was sent, from spawn on,
 * so a test can tell which screen each automated write answered (C-E2E-16). Startup
 * automation can finish before the session resolves and anyone can subscribe, and two
 * dialogs can take the same keys, so neither activities nor a polled screen pin a write
 * to the dialog it answered.
 */

import type { TerminalSize } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

export type PtyRecord = {
  /** Each chunk of output, in order. */
  readonly output: string[];
  /** Each size, from spawn on, with the number of output chunks received before it. */
  readonly sizes: { readonly after: number; readonly size: TerminalSize }[];
  /** Each write, with its time and the number of output chunks received before it. */
  readonly writes: { readonly at: number; readonly data: string; readonly after: number }[];
};

/**
 * The output, sizes, and writes of the first real PTY spawned from now on. Later PTYs run
 * unrecorded. Undo with `resetRuntimeSeamsForTests`.
 */
export function recordPty(): PtyRecord {
  const record: PtyRecord = { output: [], sizes: [], writes: [] };
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory(options);
    if (record.sizes.length > 0) return pty;
    record.sizes.push({ after: 0, size: options.size });
    pty.onData((data) => record.output.push(data));
    return {
      ...pty,
      write(data) {
        const text = Buffer.from(data).toString("utf8");
        record.writes.push({ at: Date.now(), data: text, after: record.output.length });
        pty.write(data);
      },
      resize(size) {
        record.sizes.push({ after: record.output.length, size });
        return pty.resize(size);
      },
    };
  });
  return record;
}

/** The screen the recorded PTY had painted once its first `chunks` chunks of output arrived. */
export async function screenAfter(record: PtyRecord, chunks: number): Promise<string> {
  const [spawned, ...resized] = record.sizes;
  if (spawned === undefined) throw new Error("No PTY was spawned");
  const terminal = createHeadlessTerminal(spawned.size, () => {});
  try {
    for (let index = 0; index < chunks; index += 1) {
      for (const { size } of resized.filter(({ after }) => after === index)) terminal.resize(size);
      await terminal.writeOutput(record.output[index] ?? "");
    }
    return terminal.snapshot().text;
  } finally {
    terminal.dispose();
  }
}
