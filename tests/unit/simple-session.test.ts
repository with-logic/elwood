/**
 * Unit coverage for the ergonomic session facade (PRD §5.8, C-API-47/49/50): lazy +
 * idempotent start, send() joins assistant text with blank lines and excludes
 * thinking/tools, turns serialize, and close() falls back to kill / is a safe no-op.
 */

import { describe, expect, test } from "vitest";
import { activity, TestSimple } from "./simple-fakes.ts";

describe("SessionBase turns (C-API-47/49/50)", () => {
  test("does not start at construction; starts lazily on the first send", async () => {
    const s = new TestSimple();
    expect(s.launches).toBe(0);
    expect(s.session).toBeUndefined();
    await s.send("hi");
    expect(s.launches).toBe(1);
    expect(s.session).toBe(s.underlying as unknown);
  });

  test("start() is idempotent — a second start and later sends reuse ONE launch", async () => {
    const s = new TestSimple();
    const [a, b] = await Promise.all([s.start(), s.start()]); // concurrent
    expect(a).toBe(b);
    await s.send("again");
    expect(s.launches).toBe(1);
  });

  test("send() joins assistant text with blank lines and excludes thinking/tools", async () => {
    const s = new TestSimple();
    s.underlying.script = (emitter, turnId) => {
      emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      emitter.emit("activity", activity({ kind: "reasoning", text: "secret", turnId }));
      emitter.emit("activity", activity({ text: "line one", turnId }));
      emitter.emit(
        "activity",
        activity({ kind: "tool_call", toolName: "Bash", toolInput: "ls", turnId }),
      );
      emitter.emit("activity", activity({ text: "line two", turnId }));
      emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
    };
    expect(await s.send("go")).toBe("line one\n\nline two"); // no thinking, no tool text
  });

  test("a turn with no assistant text resolves to the empty string", async () => {
    const s = new TestSimple();
    s.underlying.script = (emitter, turnId) => {
      emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      emitter.emit(
        "activity",
        activity({ kind: "tool_call", toolName: "Bash", toolInput: "ls", turnId }),
      );
      emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
    };
    expect(await s.send("go")).toBe("");
  });

  test("two sequential sends each return their OWN turn's text (serialized)", async () => {
    const s = new TestSimple();
    expect(await s.send("first")).toBe("t1");
    expect(await s.send("second")).toBe("t2");
  });

  test("close() stops the underlying session; falls back to kill on stop failure", async () => {
    const s = new TestSimple();
    await s.send("hi");
    await s.close();
    expect(s.underlying.stops).toBe(1);
    expect(s.underlying.kills).toBe(0);
    // A second facade whose stop() rejects falls back to kill.
    const s2 = new TestSimple();
    s2.underlying.stop = () => Promise.reject(new Error("stop failed"));
    await s2.send("hi");
    await s2.close();
    expect(s2.underlying.kills).toBe(1);
  });

  test("close() before any start is a safe no-op", async () => {
    const s = new TestSimple();
    await expect(s.close()).resolves.toBeUndefined();
    expect(s.launches).toBe(0);
  });
});
