/** Dialogs during startup block immediate controls before semantic readiness (C-API-28/37). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { installFakes, resetFakes, tempDir } from "../claude/helpers.ts";
import { installFakes as codexFakes, resetFakes as resetCodex } from "../codex/helpers.ts";
import { FakePty } from "../helpers/fake-pty.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
  resetCodex();
});

test.each([
  "claude",
  "codex",
] as const)("C-API-28 a %s startup dialog guards model commands before the ready hook", async (agent) => {
  if (agent === "claude") installFakes();
  else codexFakes();
  const ptys: FakePty[] = [];
  const menu =
    agent === "claude"
      ? "Do you want to proceed?\r\n 1. Yes\r\n❯ 2. No\r\nEsc to cancel"
      : "Would you like to run the following command?\r\n› 1. Yes, proceed\r\n  2. No, and tell Codex what to do differently\r\nPress enter to confirm or esc to cancel";
  setPtyFactoryForTests((options) => {
    const pty = new FakePty(options);
    ptys.push(pty);
    const register = pty.onData.bind(pty);
    pty.onData = (handler) => {
      const off = register(handler);
      handler(menu);
      return off;
    };
    return pty;
  });
  const session = await (agent === "claude"
    ? startClaude({ cwd: tempDir(), autotrust: false })
    : startCodex({ cwd: tempDir(), autotrust: false }));
  try {
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    await expect(session.listModels({ timeoutMs: 100 })).rejects.toMatchObject({
      code: "model_automation_failed",
    });
    expect(ptys[0]!.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});
