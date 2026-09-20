/** Cancelled drafts cannot leak across safe queue boundaries (PRD §5.3, C-API-56). */
import { afterEach, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { startClaude } from "../../src/index.ts";
import { AgentSessionBase } from "../../src/runtime/session/base.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const clear = "\u0015\u000b";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

async function staged() {
  installFakes();
  const session = await startClaude({ cwd: tempDir() });
  if (!(session instanceof AgentSessionBase)) throw new Error("session expected");
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
  return { session, abort };
}

test.each([
  "clear",
  "failure",
  "human",
  "human_wait",
  "terminal",
  "xterm",
  "close",
] as const)("C-API-56 cancelled draft cleanup respects %s before successor input", async (mode) => {
  const { session, abort } = await staged();
  try {
    vi.useFakeTimers();
    const submission = session.sendPrompt("old");
    const rejected = expect(submission).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(1);
    expect(ptys[0]!.writes).toEqual(["\u001b[200~old\u001b[201~"]);
    session.inputBlocking = true;
    abort.abort();
    await vi.advanceTimersByTimeAsync(200);
    await rejected;
    expect(ptys[0]!.writes).not.toContain(clear);
    if (mode === "human") await session.sendKeys("human edit");
    if (mode === "terminal") await session.terminal.sendInput("human edit");
    if (mode === "xterm") session.terminal.xterm.input("human edit");
    const statuses: string[] = [];
    if (mode === "failure") {
      session.submitEvidence("hook_turn_ended");
      session.inputBlocking = false;
      expect(session.status).toBe("ready");
      session.on("status", ({ status }) => statuses.push(status));
      ptys[0]!.failOnWrite = clear;
    }
    const next = session.sendPrompt("next");
    const result = next.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(ptys[0]!.writes.some((write) => write.includes("next"))).toBe(false);
    if (mode === "close") {
      vi.useRealTimers();
      await session.stop();
      await result;
      expect(ptys[0]!.writes).not.toContain(clear);
      return;
    }
    if (mode === "human_wait") await session.sendKeys("human edit");
    session.inputBlocking = false;
    await vi.advanceTimersByTimeAsync(400);
    if (mode === "failure") {
      expect(await result).toMatchObject({ code: "wait_timeout" });
      expect(ptys[0]!.writes.some((write) => write.includes("next"))).toBe(false);
      expect(session.status).toBe("ready");
      expect(statuses).toEqual([]);
      ptys[0]!.failOnWrite = undefined;
      const retry = session.sendMessage("retry");
      await vi.advanceTimersByTimeAsync(250);
      await retry;
      expect(ptys[0]!.writes.slice(-3)).toEqual([clear, "\u001b[200~retry\u001b[201~", "\r"]);
    } else {
      await next;
      const writes = ptys[0]!.writes;
      expect(writes.includes(clear)).toBe(mode === "clear");
      if (mode === "clear")
        expect(writes.indexOf(clear)).toBeLessThan(writes.indexOf("\u001b[200~next\u001b[201~"));
    }
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
