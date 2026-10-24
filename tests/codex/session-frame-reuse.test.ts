/** Completed-frame observers share viewport conversion without changing fresh reads (PRD §4.1). */
import { afterEach, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test("C-API-15 observers share each completed frame and public snapshots stay fresh", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd, initialSize: { cols: 100, rows: 20 } });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    await session.terminal.settled();
    const buffer = session.terminal.xterm.buffer.active;
    const lines = vi.spyOn(buffer, "getLine");
    // This row is outside the cursor evidence read by question/readiness observers.
    const lastRowReads = () =>
      lines.mock.calls.filter(([row]) => row === buffer.viewportY + 19).length;
    for (const text of ["alpha", "bravo"]) {
      lines.mockClear();
      // Both frames have identical geometry; new bytes must invalidate the cache.
      ptys[0]!.emitData(`\u001b[2J\u001b[H${text}\u001b[2;1H`);
      await session.terminal.settled();
      expect(lastRowReads()).toBe(1);
      const first = session.terminal.snapshot();
      const second = session.terminal.snapshot();
      expect(first.text.startsWith(text)).toBe(true);
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(lastRowReads()).toBe(3);
    }
  } finally {
    await session.stop();
  }
});
