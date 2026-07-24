/**
 * Unit coverage for the ergonomic session's SubscriptionRegistry (PRD §5.8, C-API-52): a
 * disposer works before AND after start; a throwing attach is contained (never orphans start);
 * `off(event, handler)` scopes to the exact registration; double-dispose is a harmless no-op.
 */

import { describe, expect, test } from "vitest";
import { SubscriptionRegistry } from "../../src/core/simple/subscriptions.ts";

// A minimal live "session" whose `on` returns a real detach. Each subscription gets a distinct
// token so reusing one handler across events is tracked independently (like the real emitter).
function makeSession() {
  const live = new Set<symbol>();
  return {
    live,
    count() {
      return live.size;
    },
    on(_handler: () => void) {
      const token = Symbol("sub");
      live.add(token);
      return () => live.delete(token); // the live Unsubscribe for THIS subscription
    },
  };
}

describe("SubscriptionRegistry (C-API-52)", () => {
  test("a disposer captured BEFORE start detaches the subscription AFTER start", () => {
    const reg = new SubscriptionRegistry<ReturnType<typeof makeSession>>();
    const handler = () => {};
    const dispose = reg.add("status", handler, (s) => s.on(handler)); // buffered (no session yet)
    const session = makeSession();
    reg.attachAll(session);
    expect(session.count()).toBe(1); // attached on start
    dispose(); // the pre-start disposer must detach the now-live subscription
    expect(session.count()).toBe(0);
  });

  test("adding AFTER start attaches immediately; its disposer detaches", () => {
    const reg = new SubscriptionRegistry<ReturnType<typeof makeSession>>();
    const session = makeSession();
    reg.attachAll(session);
    const handler = () => {};
    const dispose = reg.add("status", handler, (s) => s.on(handler));
    expect(session.count()).toBe(1); // attached now
    dispose();
    expect(session.count()).toBe(0);
  });

  test("a throwing attach during start is contained and does not block later subscriptions", () => {
    const reg = new SubscriptionRegistry<ReturnType<typeof makeSession>>();
    const good = () => {};
    reg.add(
      "status",
      () => {},
      () => {
        throw new Error("attach boom"); // a consumer handler that throws on attach/replay
      },
    );
    reg.add("status", good, (s) => s.on(good)); // registered AFTER the thrower
    const session = makeSession();
    expect(() => reg.attachAll(session)).not.toThrow(); // start is not aborted
    expect(session.count()).toBe(1); // the later subscription still attached (thrower left no live sub)
  });

  test("off(event, handler) removes only the matching (event, handler); double-dispose is a no-op", () => {
    const reg = new SubscriptionRegistry<ReturnType<typeof makeSession>>();
    const session = makeSession();
    reg.attachAll(session);
    const shared = () => {}; // ONE handler reused across two events
    const disposeA = reg.add("a", shared, (s) => s.on(shared));
    reg.add("b", shared, (s) => s.on(shared));
    expect(session.count()).toBe(2); // two independent live subscriptions
    reg.removeByKey("a", shared); // must remove only the ("a", shared) registration
    reg.removeByKey("nope", shared); // no match → harmless
    expect(session.count()).toBe(1); // ("b", shared) survives
    disposeA(); // ("a", shared) already removed → double-dispose is a no-op (index < 0 guard)
    reg.removeByKey("b", shared); // remove the survivor
    expect(session.count()).toBe(0);
  });
});
