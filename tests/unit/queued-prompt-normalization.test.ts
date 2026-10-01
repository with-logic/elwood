/** Queued turns retain raw input and normalize only when active (PRD §5.8, C-API-50). */
import { afterEach, expect, test, vi } from "vitest";
import { activity, TestSimple } from "./simple-fakes.ts";

afterEach(() => vi.useRealTimers());

class NormalizingSession extends TestSimple {
  readonly normalize = vi.fn((prompt: string) => prompt.trim());
  protected override submittedPrompt = (prompt: string) => this.normalize(prompt);
}

test("C-API-50 pending turns defer normalization without changing dispatched caller input", async () => {
  vi.useFakeTimers();
  const facade = new NormalizingSession();
  const live = facade.underlying;
  live.script = (emitter) => {
    emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
    emitter.emit(
      "activity",
      activity({ kind: "user_message", text: live.sends === 1 ? "one" : "two" }),
    );
  };
  try {
    const first = facade.send("  one  ");
    const second = facade.send("  two  ");
    expect(facade.normalize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(facade.normalize).toHaveBeenCalledExactlyOnceWith("  one  ");
    expect(live.args["sendMessage"]).toEqual(["  one  "]);
    live.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await first).toBe("");
    expect(facade.normalize).toHaveBeenNthCalledWith(2, "  two  ");
    expect(live.args["sendMessage"]).toEqual(["  two  "]);
    live.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await second).toBe("");
  } finally {
    await facade.close();
  }
});
