/**
 * Buffered event subscriptions for the ergonomic session (PRD §5.8). `on` may be called before
 * the underlying session starts; registrations are buffered here and attached on start, so
 * subscribing never forces a start. Extracted from session.ts to keep both under the size cap.
 */

import type { Unsubscribe } from "../types.ts";

/**
 * One subscription registration. `attach` (built with full types by the subclass) applies it
 * to the live session — storing the closure keeps event↔payload correlation intact (no
 * `as never` at the buffer boundary). `event`/`handler` identify it so `off(event, handler)`
 * removes the RIGHT one even when a handler is reused across events. `live` holds the real
 * unsubscribe once attached, so the disposer keeps working after start.
 */
type Registration<S> = {
  readonly event: unknown;
  readonly handler: unknown;
  readonly attach: (session: S) => Unsubscribe;
  live: Unsubscribe | undefined; // set on attach; the live detach after start
};

/** The buffered-then-live subscription registry backing a session's `on`/`off`. */
export class SubscriptionRegistry<S> {
  private readonly registrations: Registration<S>[] = [];
  private live: S | undefined;

  /**
   * Add a subscription. Before start it is buffered and attached later; after start it is
   * attached now. Returns an `Unsubscribe` that works in BOTH phases: it removes the pending
   * registration before start, or invokes the stored live detach after — so a disposer captured
   * before start still detaches the handler once the session launches.
   */
  add(event: unknown, handler: unknown, attach: (session: S) => Unsubscribe): Unsubscribe {
    const reg: Registration<S> = { event, handler, attach, live: undefined };
    if (this.live) reg.live = attach(this.live);
    this.registrations.push(reg);
    return () => this.remove(reg);
  }

  /** Remove the registration matching BOTH event and handler (so a reused handler is scoped right). */
  removeByKey(event: unknown, handler: unknown): void {
    const reg = this.registrations.find((r) => r.event === event && r.handler === handler);
    if (reg) this.remove(reg);
  }

  /**
   * Bind to the started session and attach every buffered registration, storing each live detach.
   * Reentrancy-safe: `attach` can synchronously replay consumer code that itself `add`s or
   * disposes a subscription, so we iterate a SNAPSHOT (a reentrant `add` attaches itself once, via
   * the `this.live` path in `add`, and is not re-attached by this loop) and store the live detach
   * only if the registration still exists — otherwise a self-dispose during replay would leak the
   * listener, so we invoke the detach immediately. Each attach is CONTAINED: a throwing consumer
   * handler must not abort the caller (the session is already live and owned) nor block later ones.
   */
  attachAll(session: S): void {
    this.live = session;
    for (const reg of [...this.registrations]) {
      let live: Unsubscribe | undefined;
      try {
        live = reg.attach(session);
      } catch {
        // Swallow a consumer attach/replay throw so it neither orphans the session nor fails start.
        continue;
      }
      if (this.registrations.includes(reg))
        reg.live = live; // still registered — keep its live detach
      else live(); // disposed reentrantly during replay — detach now so the listener never leaks
    }
  }

  private remove(reg: Registration<S>): void {
    const index = this.registrations.indexOf(reg);
    if (index < 0) return; // already removed
    this.registrations.splice(index, 1);
    reg.live?.(); // detach from the live session if it was attached
  }
}
