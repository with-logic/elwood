/** Native queued question editors hold ordinary caller input (C-ATTN-02). */
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexComposer, codexTty, tty } from "../fixtures/trust-composer.ts";
import { fixture } from "../unit/codex-questions/helpers.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-ATTN-02 captured queued question editor holds input until native clearance", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd, initialSize: { cols: 140, rows: 45 } });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    ptys[0]!.emitData(`\u001b[2J\u001b[H${tty(fixture("async-editor-first.txt"))}`);
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    const before = [...ptys[0]!.writes];
    const queued = session.sendMessage("after the native question");
    void queued.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ptys[0]!.writes).toEqual(before);
    expect(session.status).toBe("blocked");
    ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty(codexComposer)}`);
    await session.terminal.settled();
    await queued;
    expect(ptys[0]!.writes.slice(before.length)).toEqual([
      "\u001b[200~after the native question\u001b[201~",
      "\r",
    ]);
    expect(session.status).toBe("running");
  } finally {
    await session.kill();
  }
});
