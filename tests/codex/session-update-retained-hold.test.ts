/** Production update input holds use the live terminal predicate (C-CODEX-12). */
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexSmallComposer, codexTrust, codexTty } from "../fixtures/trust-composer.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  "unknown",
  "trust",
] as const)("C-CODEX-12 %s replacement keeps its exact attention through working repaints", async (replacement) => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd, autotrust: false });
  const labels: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "attention") labels.push(event.label);
  });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    ptys[0]!.emitData(asScreen("Update available! 0.151.0 -> 0.152.0"));
    await session.terminal.settled();
    const sent = session.sendMessage("after the dialog");
    void sent.catch(() => undefined);
    const expected =
      replacement === "trust" ? "codex-workspace_trust-prompt" : "codex-unidentified-dialog";
    ptys[0]!.emitData(
      asScreen(
        replacement === "trust"
          ? `${codexTrust}\n› 1. Yes, continue\n  2. No, quit`
          : "Confirm archive removal?\n❯ Proceed\n  Cancel",
      ),
    );
    await session.terminal.settled();
    expect(labels.at(-1)).toBe(expected);
    ptys[0]!.emitData(
      `\u001b]0;⠋ Working\u0007${asScreen("• Working (3s • esc to interrupt)\nRepainting choices…")}`,
    );
    await session.terminal.settled();
    expect(labels.at(-1)).toBe(expected);
    expect(session.status).toBe("blocked");
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData(
      `\u001b]0;project\u0007\u001b[2J\u001b[H${codexTty(codexSmallComposer, false)}`,
    );
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
