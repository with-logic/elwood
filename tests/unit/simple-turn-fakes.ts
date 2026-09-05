/**
 * Shared fakes for the ergonomic-turn unit tests (PRD §5.8): a scriptable session that
 * emits activity/status/hook events, and helpers to drive and collect one turn.
 */

import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import type { SendOptions } from "../../src/core/images/types.ts";
import type { TurnEvent } from "../../src/core/simple/events.ts";
import {
  runTurn,
  type StreamTurnOptions,
  type TurnBoundaryHook,
  type TurnSession,
} from "../../src/core/simple/turn.ts";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";

export function activity(partial: Partial<ElwoodActivityEvent>): ElwoodActivityEvent {
  return {
    elwoodSessionId: "s1",
    agent: "claude",
    source: "transcript",
    kind: "assistant_message",
    label: "assistant",
    ...partial,
  };
}

/** The correlated event map the turn fake delivers — the three events `runTurn` subscribes to. */
type FakeEventMap = {
  activity: ElwoodActivityEvent;
  status: { readonly elwoodSessionId?: string; readonly status: ElwoodSessionStatus };
  hook: TurnBoundaryHook;
};

/**
 * A scriptable fake turn session that genuinely `implements TurnSession` (so `runTurn` accepts it
 * with NO `as unknown as` cast, and an interface drift fails the tests to compile). Handlers are
 * stored under a correlated `FakeEventMap`, so a misspelled event or wrong payload is a type error.
 * `sendResult` lets a test make submission reject (e.g. a terminal `session_not_running`).
 */
export class FakeTurnSession implements TurnSession {
  status: ElwoodSessionStatus = "ready";
  private readonly handlers: {
    [E in keyof FakeEventMap]: Array<(event: FakeEventMap[E]) => void>;
  } = { activity: [], status: [], hook: [] };
  script: () => void = () => {};
  sendResult: Promise<void> = Promise.resolve();
  submissions = 0; // how many times sendMessage was invoked (proves no late submit is dropped)
  sentOptions: SendOptions | undefined;
  on<E extends keyof FakeEventMap>(
    event: E,
    handler: (event: FakeEventMap[E]) => void,
  ): () => void {
    this.handlers[event].push(handler);
    // A REAL unsubscribe: removes the exact handler, so a test can assert the runner cleans up
    // its activity/hook/status listeners (a no-op disposer would mask a per-turn listener leak).
    return () => {
      const list = this.handlers[event];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    };
  }
  /** Total live listeners across all events — must return to 0 once a turn settles. */
  listenerCount(): number {
    return this.handlers.activity.length + this.handlers.status.length + this.handlers.hook.length;
  }
  emit<E extends keyof FakeEventMap>(event: E, payload: FakeEventMap[E]): void {
    for (const h of [...this.handlers[event]]) h(payload);
  }
  sendMessage(_message: string, options?: SendOptions): Promise<void> {
    this.submissions += 1;
    this.sentOptions = options;
    this.script();
    return this.sendResult;
  }
}

/** A deferred promise handle, for tests that control exactly when `sendMessage` resolves. */
export function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function drive(script: (s: FakeTurnSession) => void): FakeTurnSession {
  const s = new FakeTurnSession();
  s.script = () => script(s);
  return s;
}

export async function collect(gen: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Run a turn with fast test timings (small quiet window, generous catch-up); returns events. */
export function run(s: FakeTurnSession, fallbackQuietMs = 20): Promise<TurnEvent[]> {
  return collect(runTurn(s, "go", { fallbackQuietMs, catchUpMs: 5_000 }).events);
}

/** Run a turn and return both its events and completion promise (for lifecycle assertions). */
export function runTurnFake(s: FakeTurnSession, options: StreamTurnOptions = {}) {
  return runTurn(s, "go", { fallbackQuietMs: 20, catchUpMs: 5_000, ...options });
}

export { runTurn, type TurnSession };
