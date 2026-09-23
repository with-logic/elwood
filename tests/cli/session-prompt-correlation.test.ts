/** CLI facades preserve caller input while applying adapter prompt identity (C-CLI-04, C-API-48). */
import { afterEach, expect, test, vi } from "vitest";
import { HeadlessCliSession } from "../../src/cli/session/index.ts";
import { activity, FakeUnderlying } from "../unit/simple-fakes.ts";
import { effectiveRequest } from "./main-fakes.ts";

afterEach(() => vi.useRealTimers());

test.each([
  "codex",
  "claude",
] as const)("C-API-48 %s CLI correlates its own submitted text", async (agent) => {
  vi.useFakeTimers();
  const raw = "  a\u0001b\tword\rlast  ";
  const live = new FakeUnderlying();
  live.script = (emitter) => {
    emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
    emitter.emit(
      "activity",
      activity({
        kind: "user_message",
        text: agent === "codex" ? "ab\tword\nlast" : raw,
      }),
    );
    emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
  };
  const facade = new HeadlessCliSession(effectiveRequest({ agent }), "s1", async () => live);
  try {
    const result = facade.send(raw).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(live.sends).toBe(1);
    expect(await result).toBe("");
    expect(live.args["sendMessage"]).toEqual([raw]);
  } finally {
    await facade.close();
  }
});
