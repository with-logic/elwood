/**
 * Small typed event emitter used by sessions and hook dispatch.
 * Implements PRD §5.4.
 */

import type { ElwoodEventMap, Unsubscribe } from "../core/types.ts";

type Handler = (event: unknown) => unknown;
type EventKey<M> = Extract<keyof M, string>;
type HandlerFor<M, E extends EventKey<M>> = (event: M[E]) => unknown;

export class TypedEmitter<M extends Record<string, unknown> = ElwoodEventMap> {
  private readonly handlers: Map<EventKey<M>, Set<Handler>>;

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
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set<Handler>();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler);
  }

  off<E extends EventKey<M>>(event: E, handler: HandlerFor<M, E>): void {
    this.handlers.get(event)?.delete(handler as Handler);
  }

  emit<E extends EventKey<M>>(event: E, payload: M[E]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // Deliver to EVERY subscriber before surfacing any failure: one throwing
    // listener must not abort iteration and wedge an internal lifecycle
    // subscriber (e.g. interrupt/compact settling on a status transition, or
    // the transcript watcher's flush). The first error is rethrown after the
    // full fan-out so an enclosing error boundary can still observe it.
    let firstError: unknown;
    let failed = false;
    for (const handler of [...set]) {
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
    return (this.handlers.get(event)?.size ?? 0) > 0;
  }

  async request<E extends EventKey<M>>(event: E, payload: M[E]): Promise<unknown> {
    const set = this.handlers.get(event);
    if (!set) return undefined;
    for (const handler of set) {
      const result = await handler(payload);
      if (result !== undefined) return result;
    }
    return undefined;
  }
}
