/**
 * Unit coverage for the ergonomic session facade (PRD §5.8, C-API-47/49/50/51): lazy +
 * idempotent start, send() joins assistant text with blank lines and excludes
 * thinking/tools, turns serialize, and close() is a safe no-op before start.
 */

import { describe, expect, test } from "vitest";
import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import type { ElwoodAgentSession, ElwoodCommonEventMap } from "../../src/core/agent-session.ts";
import { SimpleSession } from "../../src/core/simple/session.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

type Emitter = TypedEmitter<ElwoodCommonEventMap>;

function activity(partial: Partial<ElwoodActivityEvent>): ElwoodActivityEvent {
  return {
    elwoodSessionId: "s1",
    agent: "claude",
    source: "transcript",
    kind: "assistant_message",
    label: "assistant",
    ...partial,
  };
}

/** A fake underlying session that scripts a turn per sendMessage against an emitter. */
class FakeUnderlying {
  readonly emitter: Emitter = new TypedEmitter<ElwoodCommonEventMap>();
  status = "ready" as const;
  stops = 0;
  kills = 0;
  private turn = 0;
  script: (emitter: Emitter, turnId: string) => void = defaultScript;
  on(event: keyof ElwoodCommonEventMap, handler: (e: never) => void) {
    return this.emitter.on(event, handler as never);
  }
  sendMessage(message: string): Promise<void> {
    void message;
    this.turn += 1;
    this.script(this.emitter, `t${this.turn}`);
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.stops += 1;
    return Promise.resolve();
  }
  kill(): Promise<void> {
    this.kills += 1;
    return Promise.resolve();
  }
}

function defaultScript(emitter: Emitter, turnId: string): void {
  emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
  emitter.emit("activity", activity({ text: turnId, turnId }));
  emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
}

/** A test facade whose launch() records how many times the underlying was started. */
class TestSimple extends SimpleSession<ElwoodAgentSession> {
  launches = 0;
  readonly underlying = new FakeUnderlying();
  protected launch(): Promise<ElwoodAgentSession> {
    this.launches += 1;
    return Promise.resolve(this.underlying as unknown as ElwoodAgentSession);
  }
}

describe("SimpleSession (C-API-47/49/50/51)", () => {
  test("does not start at construction; starts lazily on the first send", async () => {
    const s = new TestSimple();
    expect(s.launches).toBe(0);
    expect(s.session).toBeUndefined();
    await s.send("hi", { settleGraceMs: 5 });
    expect(s.launches).toBe(1);
    expect(s.session).toBe(s.underlying as unknown);
  });

  test("start() is idempotent — a second start and later sends reuse ONE launch", async () => {
    const s = new TestSimple();
    const [a, b] = await Promise.all([s.start(), s.start()]); // concurrent
    expect(a).toBe(b);
    await s.send("again", { settleGraceMs: 5 });
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
    expect(await s.send("go", { settleGraceMs: 5 })).toBe("line one\n\nline two"); // no thinking, no tool text
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
    expect(await s.send("go", { settleGraceMs: 5 })).toBe("");
  });

  test("two sequential sends each return their OWN turn's text (serialized)", async () => {
    const s = new TestSimple();
    expect(await s.send("first", { settleGraceMs: 5 })).toBe("t1");
    expect(await s.send("second", { settleGraceMs: 5 })).toBe("t2");
  });

  test("close() stops the underlying session; falls back to kill on stop failure", async () => {
    const s = new TestSimple();
    await s.send("hi", { settleGraceMs: 5 });
    await s.close();
    expect(s.underlying.stops).toBe(1);
    expect(s.underlying.kills).toBe(0);
    // A second facade whose stop() rejects falls back to kill.
    const s2 = new TestSimple();
    s2.underlying.stop = () => Promise.reject(new Error("stop failed"));
    await s2.send("hi", { settleGraceMs: 5 });
    await s2.close();
    expect(s2.underlying.kills).toBe(1);
  });

  test("close() before any start is a safe no-op", async () => {
    const s = new TestSimple();
    await expect(s.close()).resolves.toBeUndefined();
    expect(s.launches).toBe(0);
  });
});
