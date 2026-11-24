/** A resumed Codex preserves the live approval hold during scrollback (C-API-28). */
import { afterEach, expect, test } from "vitest";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { viewTerminalHistory } from "../helpers/live-buffer-fixture.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-API-28 a live approval defers composer readiness while a resumed host views history", async () => {
  const cwd = tempDir();
  installFakes();
  const session = await startCodex({ cwd });
  await becomeReady(session.elwoodSessionId, cwd);
  await session.stop();
  const resumed = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
  const pty = ptys[1]!;
  try {
    const { isScrolled, paint } = await viewTerminalHistory(resumed.terminal, pty);
    const first = resumed.sendMessage("after permission");
    void first.catch(() => undefined);
    await paint(
      "Would you like to run the following command?\r\n› 1. Yes\r\nPress enter to confirm or esc to cancel",
    );
    expect(resumed.status).toBe("blocked");
    expect(pty.writes).toEqual([]);
    await paint(codexTty(codexComposer));
    await first;
    expect(isScrolled()).toBe(true);
    expect(pty.writes).toEqual(["\u001b[200~after permission\u001b[201~", "\r"]);
  } finally {
    await resumed.stop();
  }
});
