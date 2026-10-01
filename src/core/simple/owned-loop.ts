/** Bind one selected Codex loop to native acceptance and confirmed completion (PRD §5.9). */
import { createBoundaryObserver } from "./boundary-observer.ts";
import { boundaryText } from "./boundary-signal.ts";
import type { BoundarySession } from "./observe-boundary.ts";
import { type NativeTurnReader, TurnIdentity } from "./turn-identity.ts";

export function observeOwnedLoop(
  owner: object,
  session: BoundarySession,
  closing: AbortSignal,
  reader: NativeTurnReader,
) {
  const identity = new TurnIdentity(owner, reader);
  let accepted = false;
  const subscriptions: Array<() => void> = [];
  const observer = createBoundaryObserver(closing, { accepted: () => accepted }, () => {
    for (const off of subscriptions.splice(0)) off();
  });
  const idle = () => {
    if (identity.ready()) observer.confirmIdle({ interrupted: identity.hooklessCompleted });
  };
  // Reservation checks closing synchronously before constructing this observer.
  subscriptions.push(
    session.on("hook", (event) => {
      accepted = identity.observe(event);
    }),
    session.on("activity", (event) => {
      if (identity.acceptsContent(event.turnId)) observer.observeActivity(event);
    }),
    session.on("status", ({ status }) => {
      if (status === "ready") idle();
      else observer.observeStatus({ status });
    }),
    identity.observeBoundary((signal) => {
      observer.confirmStop(boundaryText(signal), true);
      idle();
    }, idle),
  );
  return {
    beforeEnter: identity.beforeEnter,
    promise: observer.promise,
    // Failed physical writes may already own native work; only pre-Enter failure discards it.
    discard: () => {
      if (!identity.attempted) observer.discard();
    },
  };
}
