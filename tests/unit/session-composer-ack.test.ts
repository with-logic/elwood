/** Actual session queues wait for native empty-composer acknowledgement (C-API-56). */
import { afterEach, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { claudeComposer, claudeTty, codexComposer, codexTty } from "../fixtures/trust-composer.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test.each([
    "staged",
    "old-empty",
  ] as const)(`C-API-56 ${agent} holds successor after clear on %s frame`, async (mode) => {
    const fake = agent === "claude" ? claude : codex;
    fake.installFakes();
    const cwd = fake.tempDir();
    const session = await (agent === "claude" ? startClaude : startCodex)({ cwd });
    const pty = fake.ptys[0]!;
    const empty = agent === "claude" ? claudeTty(claudeComposer) : codexTty(codexComposer);
    const draft = empty.replace(
      agent === "claude" ? /^❯[^\r\n]*/m : /^›[^\r\n]*/m,
      agent === "claude" ? "❯ old" : "› old",
    );
    const paint = (frame: string) => `\u001b[2J\u001b[H${frame}`;
    const abort = new AbortController();
    const send = ControlQueue.prototype.send;
    vi.spyOn(ControlQueue.prototype, "send").mockImplementation(function (
      this: ControlQueue,
      input,
      kind,
      attach,
      options,
    ) {
      return send.call(
        this,
        input,
        kind,
        attach,
        input === "old"
          ? { cancel: { signal: abort.signal, error: () => new Error("cancelled") } }
          : options,
      );
    });
    const write = pty.write.bind(pty);
    vi.spyOn(pty, "write").mockImplementation((data) => {
      write(data);
      if (String(data).includes("old")) {
        if (mode === "staged") pty.emitData(paint(draft));
        abort.abort();
      }
    });
    try {
      pty.emitData(paint(empty));
      await session.terminal.settled();
      vi.useFakeTimers();
      const first = session.sendPrompt("old").catch((error: unknown) => error);
      const successor = session.sendPrompt("next");
      void successor.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(200);
      expect(pty.writes).toContain("\u0015\u000b");
      if (mode === "staged") expect(session.terminal.snapshot().text).toContain("old");
      expect(pty.writes.some((data) => data.includes("next"))).toBe(false);
      pty.emitData(paint(empty));
      await vi.advanceTimersByTimeAsync(500);
      expect(await first).toMatchObject({ message: "cancelled" });
      await successor;
      expect(pty.writes.slice(-2)).toEqual(["\u001b[200~next\u001b[201~", "\r"]);
    } finally {
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
