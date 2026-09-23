/** Real session queue/input cancellation of turn recovery (PRD §5.3/§5.8, C-API-58). */
import { afterEach, expect, test, vi } from "vitest";
import { runTurn } from "../../src/core/simple/turn.ts";
import { ClaudeSession } from "../../src/index.ts";
import { AgentSessionBase } from "../../src/runtime/session/base.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { collect, FakeTurnSession } from "../unit/simple-turn-fakes.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  ["queued", "failed"],
  ["held", "failed"],
  ["queued", "terminal"],
  ["held", "terminal"],
  ["staged", "failed"],
  ["staged", "terminal"],
] as const)("C-API-58 cancels a %s replay on %s settlement before releasing the boundary", async (mode, settlement) => {
  installFakes();
  const facade = new ClaudeSession({ cwd: tempDir() });
  const raw = await facade.start();
  try {
    expect(raw).toBeInstanceOf(AgentSessionBase);
    if (!(raw instanceof AgentSessionBase)) throw new Error("expected session base");
    raw.submitEvidence("initial_ready");
    vi.useFakeTimers();
    const s = new FakeTurnSession();
    const write = ptys[0]!.write.bind(ptys[0]!);
    vi.spyOn(ptys[0]!, "write").mockImplementation((data) => {
      write(data);
      if (mode === "staged" && s.submissions === 2 && String(data).includes("old prompt"))
        raw.inputBlocking = true;
    });
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
        if (mode !== "queued") raw.submitEvidence("hook_turn_ended");
        raw.inputBlocking = mode !== "staged";
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
    expect(ptys[0]!.writes).not.toContain("\u0015\u000b");
    const successor = mode === "staged" ? raw.sendMessage("next prompt") : undefined;
    await vi.advanceTimersByTimeAsync(50);
    expect(ptys[0]!.writes.some((write) => write.includes("next prompt"))).toBe(false);
    raw.inputBlocking = false;
    raw.submitEvidence("hook_turn_ended");
    await vi.advanceTimersByTimeAsync(500);
    if (mode === "staged") {
      expect(ptys[0]!.writes).toContain("\u0015\u000b");
      expect(ptys[0]!.writes.some((write) => write.includes("next prompt"))).toBe(false);
      ptys[0]!.emitData(`\u001b[2J\u001b[H${claudeTty(claudeComposer)}`);
      await vi.advanceTimersByTimeAsync(500);
    }
    await successor;
    expect(ptys[0]!.writes.filter((w) => w.includes("old prompt"))).toHaveLength(
      mode === "staged" ? 2 : 1,
    );
    expect(ptys[0]!.writes.filter((w) => w === "\r")).toHaveLength(mode === "staged" ? 2 : 1);
    if (mode === "staged")
      expect(ptys[0]!.writes.slice(-3)).toEqual([
        "\u0015\u000b",
        "\u001b[200~next prompt\u001b[201~",
        "\r",
      ]);
  } finally {
    vi.useRealTimers();
    await facade.close();
  }
});
