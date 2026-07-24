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

  test("every control method lazy-starts and delegates to the live session", async () => {
    const s = new TestSimple();
    await s.sendPrompt("p");
    await s.sendGuidance("g");
    await s.sendKeys("k");
    await s.resize({ cols: 80, rows: 24 });
    await s.interrupt();
    await s.compact();
    await s.setModel("m");
    expect(await s.listModels()).toEqual([]);
    expect(await s.waitForStatus(() => true)).toBe("ready");
    await s.waitForActivity(() => true);
    await s.teardown();
    expect(s.launches).toBe(1); // all delegated through ONE lazy start
    expect(s.underlying.calls).toEqual([
      "sendPrompt",
      "sendGuidance",
      "sendKeys",
      "resize",
      "interrupt",
      "compact",
      "setModel",
      "listModels",
      "waitForStatus",
      "waitForActivity",
      "teardown",
    ]);
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
