/**
 * Coverage that the public `send`/`stream` options reach `runTurn` through `SessionBase` and that
 * there is NO default whole-turn timeout (PRD §5.8, C-API-48/49). Uses fake timers to prove a
 * default-options turn stays pending far beyond any plausible former default, and that a
 * caller-supplied `timeoutMs` is actually honored via the facade — not only via `runTurn` directly.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ElwoodAgentSession, ElwoodCommonEventMap } from "../../src/core/agent-session.ts";
import { SessionBase } from "../../src/core/simple/session.ts";
import { defaultBoundarySignal } from "../../src/core/simple/turn.ts";
import { activity, FakeUnderlying } from "./simple-fakes.ts";

/** A facade whose underlying session STARTS a turn (emits `running`) but never settles it. */
class StallingSession extends SessionBase<ElwoodAgentSession> {
  readonly underlying = new FakeUnderlying();
  constructor() {
    super();
    // Script: the turn starts (running) and emits one text event, then goes quiet forever — no
    // `ready`, no Stop hook — so only a whole-turn `timeoutMs` (or nothing) can end it.
    this.underlying.script = (emitter) => {
      emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      emitter.emit("activity", activity({ text: "partial", turnId: "t1" }));
    };
  }
  protected launch(): Promise<ElwoodAgentSession> {
    return Promise.resolve(this.underlying);
  }
  protected readBoundarySignal = defaultBoundarySignal;
  on<E extends keyof ElwoodCommonEventMap>(
    event: E,
    handler: (e: ElwoodCommonEventMap[E]) => void,
  ) {
    return this.subscribe(event, handler, (session) => session.on(event, handler));
  }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    /* consume */
  }
}

describe("SessionBase turn options + no-default-timeout (C-API-48/49)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a default-options turn has NO whole-turn timeout — it stays pending past any former default", async () => {
    const s = new StallingSession();
    let settled = false;
    const run = drain(s.stream("go")).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(600_000); // 10 minutes — far beyond any plausible old default
    expect(settled).toBe(false); // still pending: there is genuinely no default timeout
    // Cleanup: a terminal status ends it so the promise resolves (no dangling timer/turn).
    s.underlying.emitter.emit("status", { elwoodSessionId: "s1", status: "exited" });
    await run;
    expect(settled).toBe(true);
  });

  test("a facade-supplied timeoutMs reaches runTurn (via stream) and ends the stalled turn", async () => {
    const s = new StallingSession();
    const rejected = drain(s.stream("go", { timeoutMs: 5_000 })).then(
      () => "resolved",
      (e: { code?: string }) => e.code,
    );
    await vi.advanceTimersByTimeAsync(5_001); // cross the caller-supplied ceiling
    expect(await rejected).toBe("wait_timeout"); // the option was forwarded and honored
  });

  test("the `send` path ALSO forwards its options to runTurn, not just `stream` (both public paths)", async () => {
    // C-API-49: send and stream share one turn boundary and pass the SAME options object to the
    // runner. Prove `send` (not only `stream`) forwards it — a dropped `options ?? {}` on the send
    // path would leave this hanging. (Both `timeoutMs` and `catchUpMs` ride that same object; the
    // per-option behavior of `catchUpMs` is pinned at the runner level in simple-turn-timeout.)
    const s = new StallingSession();
    const rejected = s.send("go", { timeoutMs: 4_000 }).then(
      () => "resolved",
      (e: { code?: string }) => e.code,
    );
    await vi.advanceTimersByTimeAsync(4_001);
    expect(await rejected).toBe("wait_timeout"); // send forwarded its options object to runTurn
  });

  test("C-CLI-04 forwards ordered images through the normalized turn submission", async () => {
    const s = new StallingSession();
    const images = [{ path: "/tmp/first.png" }, { path: "/tmp/second.png" }] as const;
    const turn = drain(s.stream("inspect", { images, timeoutMs: 1 }));
    const rejection = expect(turn).rejects.toMatchObject({ code: "wait_timeout" });
    await vi.advanceTimersByTimeAsync(2);
    await rejection;
    expect(s.underlying.args["sendMessage"]).toEqual(["inspect", { images }]);
  });

  test("control methods go through IMMEDIATELY while a `send`/`stream` turn is still running (C-API-52)", async () => {
    const s = new StallingSession();
    // Begin a stream turn and pull its first event so the turn is demonstrably in flight (running).
    const gen = s.stream("go");
    const first = await gen.next(); // yields the "partial" event → the turn is now running
    expect(first.value).toEqual({ type: "text", text: "partial" });
    // The turn never reaches `ready` (StallingSession), so if controls QUEUED behind it they would
    // hang. They must reach the live session immediately instead.
    await s.interrupt({ timeoutMs: 1 });
    await s.sendKeys("x");
    expect(s.underlying.calls).toContain("interrupt"); // delivered without waiting for the turn
    expect(s.underlying.calls).toContain("sendKeys");
    // Cleanup: end the turn.
    s.underlying.emitter.emit("status", { elwoodSessionId: "s1", status: "exited" });
    await drain(gen);
  });
});
