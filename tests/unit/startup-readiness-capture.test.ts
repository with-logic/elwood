/** Startup screen capture ends when the session cancels readiness (C-ATTN-06). */
import { expect, test, vi } from "vitest";
import { createStartupReadinessGate } from "../../src/runtime/session/startup-readiness.ts";
import * as cursor from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

test("C-ATTN-06 stop capturing startup screens after cancellation", async () => {
  const terminal = createHeadlessTerminal({ cols: 40, rows: 5 }, () => {});
  const reads = vi.spyOn(cursor, "settledLiveSnapshot");
  const readiness = createStartupReadinessGate(() => {}, false, {
    session: { agent: "claude", elwoodSessionId: "session" },
    configured: () => false,
    warnings: { emitWarnings: () => {} },
    events: { emit: () => {} },
  });
  try {
    await terminal.writeOutput("Initial screen");
    expect(readiness.observeStartupFrame(terminal).text).toContain("Initial screen");
    expect(reads).toHaveBeenCalledTimes(1);

    readiness.ready.cancel();
    await terminal.writeOutput("\r\nTrailing output");
    expect(readiness.observeStartupFrame(terminal).text).toContain("Trailing output");
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    reads.mockRestore();
    terminal.dispose();
  }
});
