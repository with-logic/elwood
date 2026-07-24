/**
 * Unit coverage for the ergonomic session's FULL control surface (PRD §5.8, C-API-47/51):
 * every control method lazy-starts and delegates; stop/kill/teardown are no-ops before
 * start; `status` is `starting` pre-start; `on`/`off` buffer before start and detach.
 */

import { describe, expect, test } from "vitest";
import { TestSimple } from "./simple-fakes.ts";

describe("SessionBase control surface (C-API-47/51)", () => {
  test("sendMessage delegates through lazy start (the base's queued-message path)", async () => {
    const s = new TestSimple();
    await s.sendMessage("direct"); // the base method, not the send()/stream() turn path
    expect(s.launches).toBe(1);
    expect(s.session).toBeDefined();
  });

  test("every control method lazy-starts and forwards its arguments faithfully", async () => {
    const s = new TestSimple();
    // Distinctive arguments per method, so a wrapper that dropped/altered any would be caught.
    const statusMatch = (s: string) => s === "ready";
    const activityMatch = (e: { kind: string }) => e.kind === "assistant_message";
    const size = { cols: 80, rows: 24 };
    const bytes = new Uint8Array([1, 2, 3]);
    await s.sendPrompt("prompt-x", { images: [] });
    await s.sendGuidance("guide-y", { images: [] });
    await s.sendKeys(bytes);
    await s.resize(size);
    await s.interrupt({ timeoutMs: 111 });
    await s.compact({ timeoutMs: 222 });
    await s.setModel("model-z", { timeoutMs: 333 });
    await s.listModels({ timeoutMs: 444 });
    await s.waitForStatus(statusMatch, 555);
    await s.waitForActivity(activityMatch, 666);
    await s.teardown();
    expect(s.launches).toBe(1); // all delegated through ONE lazy start
    const a = s.underlying.args;
    expect(a["sendPrompt"]).toEqual(["prompt-x", { images: [] }]);
    expect(a["sendGuidance"]).toEqual(["guide-y", { images: [] }]);
    expect(a["sendKeys"]).toEqual([bytes]);
    expect(a["resize"]).toEqual([size]);
    expect(a["interrupt"]).toEqual([{ timeoutMs: 111 }]);
    expect(a["compact"]).toEqual([{ timeoutMs: 222 }]);
    expect(a["setModel"]).toEqual(["model-z", { timeoutMs: 333 }]);
    expect(a["listModels"]).toEqual([{ timeoutMs: 444 }]);
    expect(a["waitForStatus"]).toEqual([statusMatch, 555]);
    expect(a["waitForActivity"]).toEqual([activityMatch, 666]);
  });

  test("stop()/kill()/teardown() before start are no-ops; after start they delegate", async () => {
    const s = new TestSimple();
    await s.stop();
    await s.kill();
    await s.teardown(); // all no-ops: never started
    expect(s.launches).toBe(0);
    await s.start();
    await s.stop();
    await s.kill();
    expect(s.underlying.stops).toBe(1);
    expect(s.underlying.kills).toBe(1);
  });

  test("close() when BOTH stop and kill fail throws termination_failed with both causes", async () => {
    const s = new TestSimple();
    await s.start();
    s.underlying.stop = () => Promise.reject(new Error("stop boom"));
    s.underlying.kill = () => Promise.reject(new Error("kill boom"));
    await expect(s.close()).rejects.toMatchObject({
      code: "termination_failed",
      details: { cause: "stop boom", killCause: "kill boom" },
    });
  });

  test("status getter is `starting` before start, then reflects the live session", async () => {
    const s = new TestSimple();
    expect(s.status).toBe("starting");
    await s.start();
    expect(s.status).toBe("ready"); // FakeUnderlying.status
  });

  test("on() before start is buffered + attached on start; off() removes buffered and live subs", async () => {
    const s = new TestSimple();
    const seen: string[] = [];
    s.on("status", (e) => seen.push(e.status)); // buffered
    const dropped: string[] = [];
    const off = s.on("status", (e) => dropped.push(e.status));
    off(); // remove the buffered handler before start — must never attach
    await s.start();
    s.underlying.emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
    expect(seen).toEqual(["running"]); // the retained buffered handler fired
    expect(dropped).toEqual([]); // the removed one never did
    // off() on a LIVE subscription detaches too.
    const live: string[] = [];
    const offLive = s.on("status", (e) => live.push(e.status));
    offLive();
    s.underlying.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
    expect(live).toEqual([]);
    // off() with a handler that was never subscribed is a harmless no-op (index < 0).
    expect(() => s.off("status", () => {})).not.toThrow();
  });
});
