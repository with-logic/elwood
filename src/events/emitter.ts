/**
 * Small typed event emitter used by sessions and hook dispatch.
 * Implements PRD §5.4.
 */

import type {
  ElwoodEventHandler,
  ElwoodEventMap,
  ElwoodEventName,
  Unsubscribe,
} from "../core/types.ts";

type Handler = (event: unknown) => unknown;

export class TypedEmitter {
  private readonly handlers: Map<ElwoodEventName, Set<Handler>>;

  constructor() {
    this.handlers = new Map();
  }

  on<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): Unsubscribe {
    this.listen(event, handler);
    return () => {
      this.off(event, handler);
    };
  }

  listen<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set<Handler>();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler);
  }

  off<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void {
    this.handlers.get(event)?.delete(handler as Handler);
  }

  emit<E extends ElwoodEventName>(event: E, payload: ElwoodEventMap[E]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      handler(payload);
    }
  }

  async request<E extends ElwoodEventName>(event: E, payload: ElwoodEventMap[E]): Promise<unknown> {
    const set = this.handlers.get(event);
    if (!set) return undefined;
    for (const handler of set) {
      const result = await handler(payload);
      if (result !== undefined) return result;
    }
    return undefined;
  }
}
