/** Real session queue/input cancellation of turn recovery (PRD §5.3/§5.8, C-API-57). */
import { afterEach, expect, test, vi } from "vitest";
import { runTurn } from "../../src/core/simple/turn.ts";
import { ClaudeSession } from "../../src/index.ts";
import { AgentSessionBase } from "../../src/runtime/session/base.ts";
import { collect, FakeTurnSession } from "../unit/simple-turn-fakes.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test.each([
  ["queued", "failed"],
  ["held", "failed"],
  ["queued", "terminal"],
  ["held", "terminal"],
] as const)("C-API-57 cancels a %s replay on %s settlement before releasing the boundary", async (mode, settlement) => {
  installFakes();
  const facade = new ClaudeSession({ cwd: tempDir() });
  const raw = await facade.start();
  expect(raw).toBeInstanceOf(AgentSessionBase);
  if (!(raw instanceof AgentSessionBase)) throw new Error("expected session base");
  raw.submitEvidence("initial_ready");
  vi.useFakeTimers();
  const s = new FakeTurnSession();
  let replaySettled = false;
  s.sendMessage = async (prompt, options) => {
    s.submissions += 1;
    const replay = s.submissions > 1;
    try {
      await raw.sendMessage(prompt, options);
    } finally {
      if (replay) replaySettled = true;
    }
    if (!replay) {
      if (mode === "held") raw.submitEvidence("hook_turn_ended");
      raw.inputBlocking = true;
      s.emit("status", { status: "running" });
      s.emit("status", { status: "ready" });
    }
  };
  const turn = runTurn(s, "old prompt", { fallbackQuietMs: 10, timeoutMs: 30, drainMs: 1 });
  const events = collect(turn.events);
  const settled =
    settlement === "failed"
      ? expect(events).rejects.toMatchObject({ code: "wait_timeout" })
      : expect(events).resolves.toEqual([]);
  let released = false;
  void turn.boundary.then(() => {
    released = true;
  });
  await vi.advanceTimersByTimeAsync(170);
  expect(s.submissions).toBe(2);
  expect(replaySettled).toBe(false);
  if (settlement === "terminal") s.emit("status", { status: "stopped" });
  await vi.advanceTimersByTimeAsync(100);
  await settled;
  expect(replaySettled).toBe(true);
  expect(released).toBe(true); // cancellation finishes while the dialog STILL holds input
  raw.inputBlocking = false;
  raw.submitEvidence("hook_turn_ended");
  await vi.advanceTimersByTimeAsync(500);
  expect(ptys[0]!.writes.filter((w) => w.includes("old prompt"))).toHaveLength(1);
  expect(ptys[0]!.writes.filter((w) => w === "\r")).toHaveLength(1);
  vi.useRealTimers();
  await facade.close();
});
