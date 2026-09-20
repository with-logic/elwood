/** Visible old composer chrome cannot release an update replacement (C-CODEX-12). */
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexSmallComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
test.each([
  "",
  "\r\n❯ Proceed\r\n  Cancel",
])("C-CODEX-12 stale cursor holds header plus %s", async (options) => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const pty = ptys[0]!;
    pty.emitData(`\u001b[2J\u001b[H${codexTty(`\n\n\n\n\n${codexSmallComposer}`)}`);
    await session.terminal.settled();
    pty.emitData("\u001b7\u001b[HUpdate available! 0.151.0 -> 0.152.0\u001b8");
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    const sent = session.sendMessage("after the dialog");
    void sent.catch(() => undefined);
    pty.emitData(`\u001b7\u001b[H\u001b[2KConfirm archive removal?${options}\u001b8`);
    await session.terminal.settled();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pty.writes).toEqual([]);
    expect(session.status).toBe("blocked");
    pty.emitData(`\u001b[2J\u001b[H${codexTty(codexSmallComposer)}`);
    await sent;
    expect(pty.writes).toEqual(["\u001b[200~after the dialog\u001b[201~", "\r"]);
  } finally {
    await session.stop();
  }
});
