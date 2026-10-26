/**
 * A FIFO with a slow, repeating writer, for tests that a reader never waits on one
 * (C-CODEX-25). A blocking read waits for the writer, so a regression ends each read with
 * `text` within `delayMs` instead of hanging the test worker, however many reads it makes.
 */

import { spawn, spawnSync } from "node:child_process";
import { onTestFinished } from "vitest";

/** How long the writer waits before each write; a read that waited took about this long. */
export const fifoWriterDelayMs = 1_000;

/** Creates a FIFO at `path` that gets `text` every `delayMs` until the test finishes. */
export function fifoWithLateWriter(path: string, text = "", delayMs = fifoWriterDelayMs): void {
  const made = spawnSync("mkfifo", [path]);
  if (made.status !== 0) throw new Error(`mkfifo ${path} failed`);
  const writer = spawn(
    "/bin/sh",
    [
      "-c",
      'while :; do sleep "$1"; printf %s "$2" > "$3"; done',
      "sh",
      String(delayMs / 1_000),
      text,
      path,
    ],
    { stdio: "ignore" },
  );
  onTestFinished(() => {
    writer.kill("SIGKILL");
  });
}
