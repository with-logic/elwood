/** Production update input holds use the live terminal predicate (C-CODEX-12). */
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexSmallComposer, codexTty } from "../fixtures/trust-composer.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-CODEX-12 queued text stays held through a replacement until its native cursor returns", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    ptys[0]!.emitData(asScreen("Update available! 0.151.0 -> 0.152.0"));
    await session.terminal.settled();
    const sent = session.sendMessage("after the dialog");
    void sent.catch(() => undefined);
    ptys[0]!.emitData(asScreen("Confirm archive removal?\n❯ Proceed\n  Cancel"));
    await session.terminal.settled();
    ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty(codexSmallComposer, false)}`);
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData("\u001b[?25h");
    await sent;
    expect(ptys[0]!.writes).toEqual(["\u001b[200~after the dialog\u001b[201~", "\r"]);
  } finally {
    await session.stop();
  }
});
