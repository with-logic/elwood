/**
 * Shared fakes for the ergonomic-turn unit tests (PRD §5.8): a scriptable session that
 * emits activity/status/hook events, and helpers to drive and collect one turn.
 */

import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import { runTurn, type TurnSession } from "../../src/core/simple/turn.ts";

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

/**
 * A scriptable fake session. The runner marks `submitted` before calling `sendMessage`, so
 * the scripted turn events (emitted during the call) are correctly attributed to this turn.
 * `sendResult` lets a test make submission reject (e.g. a terminal `session_not_running`).
 */
export class FakeTurnSession {
  status = "ready" as const;
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>();
  script: () => void = () => {};
  sendResult: Promise<void> = Promise.resolve();
  submissions = 0; // how many times sendMessage was invoked (proves no late submit is dropped)
  on(event: string, handler: (event: never) => void): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as (event: unknown) => void);
    this.handlers.set(event, list);
    return () => {};
  }
  emit(event: string, payload: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(payload);
  }
  sendMessage(): Promise<void> {
    this.submissions += 1;
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

export async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Run a turn with fast test timings (small quiet window, generous catch-up); returns events. */
export function run(s: FakeTurnSession, fallbackQuietMs = 20): Promise<unknown[]> {
  return collect(
    runTurn(s as unknown as TurnSession, "go", { fallbackQuietMs, catchUpMs: 5_000 }).events,
  );
}

/** Run a turn and return both its events and completion promise (for lifecycle assertions). */
export function runTurnFake(s: FakeTurnSession, options: Record<string, number> = {}) {
  return runTurn(s as unknown as TurnSession, "go", {
    fallbackQuietMs: 20,
    catchUpMs: 5_000,
    ...options,
  });
}

export { runTurn, type TurnSession };
