/** Real PTY output survives rendering batches and process exit (PRD §4.1, C-PERF-06). */

import { expect, test } from "vitest";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { attachPtyTerminal } from "../../src/terminal/headless.ts";

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
