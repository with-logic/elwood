/**
 * Small typed event emitter used by sessions and hook dispatch.
 * Implements PRD §5.4.
 */

import type { ElwoodEventMap, Unsubscribe } from "../core/types.ts";

type Handler = (event: unknown) => unknown;
type EventKey<M> = Extract<keyof M, string>;
type HandlerFor<M, E extends EventKey<M>> = (event: M[E]) => unknown;

// Per-event listeners as a COPY-ON-WRITE array plus a membership set. `emit`
// iterates the immutable `list` snapshot with no per-emission allocation (the hot
// path for `terminal:data` PTY chunks), while `on`/`off` — comparatively rare —
// replace `list` and mutate `live`. `live` lets `emit` skip an entry a prior
// handler unsubscribed mid-emission, so an unsubscribe takes effect immediately.
type Listeners = { list: readonly Handler[]; readonly live: Set<Handler> };

export class TypedEmitter<M extends Record<string, unknown> = ElwoodEventMap> {
  private readonly handlers: Map<EventKey<M>, Listeners>;

  constructor() {
    this.handlers = new Map();
  }

  on<E extends EventKey<M>>(event: E, handler: HandlerFor<M, E>): Unsubscribe {
    this.listen(event, handler);
    return () => {
      this.off(event, handler);
    };
  }

  listen<E extends EventKey<M>>(event: E, handler: HandlerFor<M, E>): void {
    const entry = this.handlers.get(event);
    const h = handler as Handler;
    if (!entry) {
      this.handlers.set(event, { list: [h], live: new Set([h]) });
      return;
    }
    if (entry.live.has(h)) return;
    entry.live.add(h);
    // Copy-on-write: a fresh array so any in-flight `emit` snapshot is unaffected.
    entry.list = [...entry.list, h];
  }

  off<E extends EventKey<M>>(event: E, handler: HandlerFor<M, E>): void {
    const entry = this.handlers.get(event);
    const h = handler as Handler;
    if (!entry?.live.delete(h)) return;
    // Copy-on-write removal keeps a concurrent `emit` snapshot stable; `live`
    // (already updated) makes the unsubscribe visible to that emission at once.
    entry.list = entry.list.filter((existing) => existing !== h);
  }

  emit<E extends EventKey<M>>(event: E, payload: M[E]): void {
    const entry = this.handlers.get(event);
    if (!entry) return;
    // Deliver to every subscriber before surfacing any failure: one throwing
    // listener must not abort iteration and wedge an internal lifecycle
    // subscriber (e.g. interrupt/compact settling on a status transition, or
    // the transcript watcher's flush). The first error is rethrown after the
    // full fan-out so an enclosing error boundary can still observe it. The
    // `list` snapshot is immutable, so a listener added mid-emit does not fire
    // this round; `live` is consulted so one a prior handler removed is skipped.
    const snapshot = entry.list;
    let firstError: unknown;
    let failed = false;
    for (const handler of snapshot) {
      if (!entry.live.has(handler)) continue;
      try {
        handler(payload);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    if (failed) throw firstError;
  }

  hasListeners<E extends EventKey<M>>(event: E): boolean {
    return (this.handlers.get(event)?.live.size ?? 0) > 0;
  }

  async request<E extends EventKey<M>>(event: E, payload: M[E]): Promise<unknown> {
    const entry = this.handlers.get(event);
    if (!entry) return undefined;
    for (const handler of entry.list) {
      if (!entry.live.has(handler)) continue;
      const result = await handler(payload);
      if (result !== undefined) return result;
    }
    return undefined;
  }
}
