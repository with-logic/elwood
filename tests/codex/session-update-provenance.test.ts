/** Constructed updater repaints exercise retained queue blocking (PRD §5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexSmallComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test.each([
  "2. Skip",
  "1. Update now\r\n2. Skip",
  "1. Update now\r\n3. Skip",
])("C-CODEX-12 unseen continuation %s keeps queued input blocked", async (replacement) => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const attention: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "attention") attention.push(event.label);
  });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    vi.useFakeTimers();
    const pty = ptys[0]!;
    pty.emitData("\u001b[2J\u001b[HUpdate available! 0.155.1 -> 0.156.1\r\n1. Update now");
    await vi.advanceTimersByTimeAsync(50);
    expect(session.status).toBe("blocked");
    const pending = session.sendMessage("queued caller");
    let submitted = false;
    void pending.then(
      () => {
        submitted = true;
      },
      () => {},
    );
    pty.emitData(`\u001b[2J\u001b[H${replacement}`);
    await vi.advanceTimersByTimeAsync(1500);
    expect(session.status).toBe("blocked");
    expect(attention.at(-1)).toBe(
      replacement.includes("Update now") ? "codex-update-prompt" : "codex-unidentified-dialog",
    );
    expect(submitted).toBe(false);
    expect(pty.writes).toEqual([]);
    vi.useRealTimers();
    pty.emitData(`\u001b[2J\u001b[H${codexTty(codexSmallComposer)}`);
    await session.terminal.settled();
    await pending;
    expect(pty.writes).toContain("\u001b[200~queued caller\u001b[201~");
  } finally {
    vi.useRealTimers();
    await session.stop();
  }
});
