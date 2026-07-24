/**
 * Shared fakes for the ergonomic-turn unit tests (PRD §5.8): a scriptable session that
 * emits activity/status/hook events, and helpers to drive and collect one turn.
 */

import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import { streamTurn, type TurnSession } from "../../src/core/simple/turn.ts";

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

/** A scriptable fake session: emit activity/status/hook events to drive one turn. */
export class FakeTurnSession {
  status = "ready" as const;
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>();
  script: () => void = () => {};
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
    this.script();
    return Promise.resolve();
  }
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

/** Run a turn with fast test timings (small quiet window, generous catch-up). */
export const run = (s: FakeTurnSession, fallbackQuietMs = 20) =>
  collect(streamTurn(s as unknown as TurnSession, "go", { fallbackQuietMs, catchUpMs: 5_000 }));

export { streamTurn, type TurnSession };
