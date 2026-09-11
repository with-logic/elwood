/**
 * Default no-oracle grace coverage for delayed real-agent Stop hook delivery.
 * Covers PRD §5.8 and C-API-48/C-API-49.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { activity, collect, drive, runTurn } from "./simple-turn-fakes.ts";

afterEach(() => vi.useRealTimers());

describe("streamTurn default no-oracle grace", () => {
  test("a Stop oracle arriving one second after rendered ready still retains its reply", async () => {
    vi.useFakeTimers();
    const session = drive((current) => {
      current.emit("status", { status: "running" });
      current.emit("status", { status: "ready" });
      setTimeout(() => {
        current.emit("hook", { hook_event_name: "Stop", last_assistant_message: "late reply" });
        current.emit("activity", activity({ text: "late reply", turnId: "t1" }));
      }, 1_000);
    });
    const response = collect(runTurn(session, "go").events);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(response).resolves.toEqual([{ type: "text", text: "late reply" }]);
  });
});
