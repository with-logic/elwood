/**
 * Regression coverage for the ergonomic session's turn concurrency (PRD §5.8, C-API-50/51):
 * turns run in CALL order (not iteration order); abandoning a stream early does not let the
 * next turn bind to the abandoned turn's trailing output; and `close()` during an in-flight
 * lazy start stops the resulting session rather than orphaning it.
 */

import { describe, expect, test } from "vitest";
import type { ElwoodAgentSession, ElwoodCommonEventMap } from "../../src/core/agent-session.ts";
import { SessionBase } from "../../src/core/simple/session.ts";
import { activity, FakeUnderlying, TestSimple } from "./simple-fakes.ts";

async function first(gen: AsyncGenerator<unknown>): Promise<unknown> {
  for await (const ev of gen) return ev; // take one event, then abandon (break)
  return undefined;
}

async function collectText(
  gen: AsyncGenerator<{ type: string; text?: string }>,
): Promise<string[]> {
  const out: string[] = [];
  for await (const ev of gen) if (ev.type === "text" && ev.text !== undefined) out.push(ev.text);
  return out;
}

describe("SessionBase turn concurrency (C-API-50)", () => {
  test("turns run in CALL order even when the second stream is consumed first", async () => {
    const s = new TestSimple();
    const a = s.stream("first"); // reserves slot 1 synchronously (call order)
    const b = s.stream("second"); // reserves slot 2 synchronously
    // Consume b FIRST: it must still wait for a's turn, so a's text ("t1") comes before b's.
    const bText: string[] = [];
    for await (const ev of b) if (ev.type === "text") bText.push(ev.text);
    const aText: string[] = [];
    for await (const ev of a) if (ev.type === "text") aText.push(ev.text);
    expect(aText).toEqual(["t1"]); // first-called turn produced the first turn's output
    expect(bText).toEqual(["t2"]); // second-called turn produced the second's — no cross-bleed
  });

  test("a FAILED turn does not block the next turn (the chain recovers)", async () => {
    const s = new TestSimple();
    // Turn 1's submit rejects (a non-terminal error → the turn fails); turn 2 must still run.
    let failNext = true;
    const realSend = s.underlying.sendMessage.bind(s.underlying);
    s.underlying.sendMessage = ((m: string) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("submit boom"));
      }
      return realSend(m);
    }) as typeof s.underlying.sendMessage;
    await expect(collectText(s.stream("first"))).rejects.toThrow(/submit boom/);
    // The failed turn released its slot; turn 2 runs and produces its own (non-empty) output.
    expect(await collectText(s.stream("second"))).toEqual(["t1"]); // first SUCCESSFUL submit → turn 1
  });

  test("a session START failure surfaces to the stream and frees the slot for a retry", async () => {
    let attempt = 0;
    class FlakyStart extends SessionBase<ElwoodAgentSession> {
      readonly underlying = new FakeUnderlying();
      protected launch(): Promise<ElwoodAgentSession> {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new Error("start boom"))
          : Promise.resolve(this.underlying);
      }
    }
    const s = new FlakyStart();
    // The first stream's turn cannot start (launch rejects) — the error surfaces to the consumer.
    await expect(collectText(s.stream("first"))).rejects.toThrow(/start boom/);
    // The slot was freed; a second stream retries the launch and runs.
    expect(await collectText(s.stream("second"))).toEqual(["t1"]); // fresh underlying, turn 1
  });

  test("abandoning a stream mid-turn holds B until A's real boundary; A's trailing UNTAGGED activity never bleeds into B", async () => {
    const s = new TestSimple();
    const em = s.underlying.emitter;
    // Turn A: running + ONE untagged (Claude-like) event, then it STAYS running — no ready. The
    // test drives A's trailing activity + boundary by hand, so we can abandon A while it's live.
    let aStarted = false;
    s.underlying.script = () => {
      aStarted = true;
      em.emit("status", { elwoodSessionId: "s1", status: "running" });
      em.emit("activity", activity({ text: "A-first" })); // NO turnId — Claude transcript style
    };
    const firstOfA = await first(s.stream("A")); // consume one event, then break (abandon A)
    expect(firstOfA).toEqual({ type: "text", text: "A-first" });
    expect(aStarted).toBe(true);

    // Start B. Its submission must NOT happen yet — A has not reached a real boundary.
    const bText: string[] = [];
    const bDone = (async () => {
      for await (const ev of s.stream("B")) if (ev.type === "text") bText.push(ev.text);
    })();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.underlying.sends).toBe(1); // ONLY A submitted — B is still held behind A's slot

    // A's TRAILING untagged activity arrives AFTER abandonment. It must be discarded, never
    // collected into B (the danger the missing turnId makes real). Then A reaches ready → boundary.
    em.emit("activity", activity({ text: "A-trailing" }));
    em.emit("status", { elwoodSessionId: "s1", status: "ready" }); // A's real boundary (after drain)

    // Now B may run. Script B's own turn (no Stop hook reaches this fake, so it settles via the
    // quiet window after `ready`).
    s.underlying.script = () => {
      em.emit("status", { elwoodSessionId: "s1", status: "running" });
      em.emit("activity", activity({ text: "B-only" }));
      em.emit("status", { elwoodSessionId: "s1", status: "ready" });
    };
    await bDone;
    expect(s.underlying.sends).toBe(2); // B submitted only after A settled
    expect(bText).toEqual(["B-only"]); // B saw ONLY its own text — never A-first or A-trailing
  });
});

/** A facade whose launch is a deferred promise the test resolves, to race close()/stream vs start(). */
class DeferredStartSession extends SessionBase<ElwoodAgentSession> {
  readonly underlying = new FakeUnderlying();
  launches = 0;
  resolveLaunch!: () => void;
  protected launch(): Promise<ElwoodAgentSession> {
    this.launches += 1;
    return new Promise<ElwoodAgentSession>((resolve) => {
      this.resolveLaunch = () => resolve(this.underlying);
    });
  }
  on<E extends keyof ElwoodCommonEventMap>(
    event: E,
    handler: (e: ElwoodCommonEventMap[E]) => void,
  ) {
    return this.subscribe(event, handler, (session) => session.on(event, handler));
  }
}

describe("SessionBase send/stream during in-flight start (C-API-47)", () => {
  test("a stream begun during startup shares the ONE in-flight launch and submits only after it resolves", async () => {
    const s = new DeferredStartSession();
    const starting = s.start(); // launch #1 in-flight (deferred)
    // A stream begun WHILE the launch is pending must not trigger a second launch or submit early.
    const streamed = collectText(s.stream("hello"));
    // Give the microtask queue a chance to (wrongly) launch/submit if the wiring were broken.
    await Promise.resolve();
    await Promise.resolve();
    expect(s.launches).toBe(1); // shares the SAME in-flight launch — no duplicate
    expect(s.underlying.sends).toBe(0); // NOTHING submitted before the session exists
    s.resolveLaunch(); // startup completes
    await starting;
    expect(await streamed).toEqual(["t1"]); // the turn then submits and produces its output
    expect(s.launches).toBe(1); // still exactly one launch across start() + stream()
    expect(s.underlying.sends).toBe(1); // exactly one submission, after readiness
  });

  test("stream(); close() in that exact order (launch unresolved) stops the eventual session — no orphan", async () => {
    const s = new DeferredStartSession();
    const streamed = collectText(s.stream("hello")); // reserves a slot AND triggers the start
    const closing = s.close(); // immediately after — must join the start `stream()` just triggered
    s.resolveLaunch(); // the launch resolves AFTER both stream() and close() were issued
    await closing;
    await streamed.catch(() => undefined); // the abandoned/closed turn may reject — that's fine
    expect(s.launches).toBe(1); // the synchronous start() from stream() is the one launch
    expect(s.underlying.stops).toBe(1); // close() stopped the eventual session — nothing orphaned
  });
});

describe("SessionBase close() during in-flight start (C-API-51)", () => {
  test("close() awaits the in-flight launch and stops the resulting session (no orphan)", async () => {
    const s = new DeferredStartSession();
    const starting = s.start(); // launch is now in-flight (not yet resolved)
    const closing = s.close(); // races the start — must not treat it as 'never started'
    s.resolveLaunch(); // the launch completes AFTER close() began
    await starting;
    await closing;
    expect(s.underlying.stops).toBe(1); // the session that started was stopped, not orphaned
  });

  test("close() when the in-flight launch REJECTS resolves cleanly (nothing to close)", async () => {
    let rejectLaunch!: (error: unknown) => void;
    class FailingStart extends SessionBase<ElwoodAgentSession> {
      protected launch(): Promise<ElwoodAgentSession> {
        return new Promise<ElwoodAgentSession>((_resolve, reject) => {
          rejectLaunch = reject;
        });
      }
    }
    const s = new FailingStart();
    const starting = s.start(); // in-flight
    starting.catch(() => undefined); // the start() rejection is expected/handled
    const closing = s.close(); // awaits the in-flight launch, which then rejects
    rejectLaunch(new Error("start failed"));
    await expect(closing).resolves.toBeUndefined(); // a failed launch = nothing to close
  });
});
