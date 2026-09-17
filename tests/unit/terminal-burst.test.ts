/** Real PTY output survives rendering batches and process exit (PRD §4.1, C-PERF-06). */

import { expect, test, vi } from "vitest";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { attachPtyTerminal } from "../../src/terminal/headless.ts";
import { renderHighWaterBytes } from "../../src/terminal/pty-output.ts";

test("C-PERF-06 a real PTY burst renders every byte and the final frame before settling", async () => {
  const expected = `${"x".repeat(1024 * 1024)}\r\nCOMPLETE\r\n`;
  const pty = nodePtyFactory({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(1024*1024)+'\\nCOMPLETE\\n')"],
    cwd: process.cwd(),
    env: process.env,
    size: { cols: 120, rows: 40 },
  });
  const exited = new Promise((resolve) => pty.onExit(resolve));
  const chunks: string[] = [];
  const terminal = attachPtyTerminal({ cols: 120, rows: 40 }, pty, (data) => chunks.push(data));
  try {
    await expect(exited).resolves.toMatchObject({ exitCode: 0 });
    await terminal.settled();
    expect(chunks.join("")).toBe(expected);
    expect(terminal.snapshot().text).toContain("COMPLETE");
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 64 * 1024)).toBe(true);
  } finally {
    terminal.dispose();
  }
});

test("C-PERF-06 a real PTY pauses while rendering stalls and resumes without loss", async () => {
  const payload = `${"x".repeat(2 * 1024 * 1024)}\r\nCOMPLETE\r\n`;
  const pty = nodePtyFactory({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(2*1024*1024)+'\\nCOMPLETE\\n')"],
    cwd: process.cwd(),
    env: process.env,
    size: { cols: 120, rows: 40 },
  });
  const exited = new Promise((resolve) => pty.onExit(resolve));
  let paused = false;
  let queuedBytes = 0;
  let peakQueuedBytes = 0;
  let maxChunkBytes = 0;
  const chunks: string[] = [];
  const terminal = attachPtyTerminal(
    { cols: 120, rows: 40 },
    {
      ...pty,
      onData: (handler) =>
        pty.onData((data) => {
          queuedBytes += Buffer.byteLength(data);
          peakQueuedBytes = Math.max(peakQueuedBytes, queuedBytes);
          maxChunkBytes = Math.max(maxChunkBytes, Buffer.byteLength(data));
          handler(data);
        }),
      flowControl: {
        pause: () => {
          paused = true;
          pty.flowControl!.pause();
        },
        resume: () => pty.flowControl!.resume(),
      },
    },
    (data) => {
      queuedBytes -= Buffer.byteLength(data);
      chunks.push(data);
    },
  );
  // Delay only the handoff to the real renderer; its public write API stays
  // synchronous, and the PTY, flow control, parsing and output remain real.
  const pending: Parameters<typeof terminal.xterm.write>[] = [];
  const write = terminal.xterm.write.bind(terminal.xterm);
  const handoff = vi.spyOn(terminal.xterm, "write").mockImplementation((...args) => {
    pending.push(args);
  });
  const release = () => {
    handoff.mockRestore();
    for (const args of pending.splice(0)) write(...args);
  };
  try {
    await expect.poll(() => paused, { timeout: 5000 }).toBe(true);
    expect(peakQueuedBytes).toBeLessThanOrEqual(renderHighWaterBytes + maxChunkBytes);
    release();
    await exited;
    await terminal.settled();
    expect(chunks.join("")).toBe(payload);
    expect(terminal.snapshot().text).toContain("COMPLETE");
  } finally {
    release();
    await exited;
    terminal.dispose();
  }
});
