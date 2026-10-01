/** Subscribe passive native-turn observation (PRD §5.8, C-API-48/50). */
import type { ElwoodActivityEvent } from "../activity/index.ts";
import type { ElwoodSessionStatus, Unsubscribe } from "../types.ts";
import { createBoundaryObserver } from "./boundary-observer.ts";
import type { TurnBoundaryHook } from "./turn-types.ts";

/** Only the events and current status used by passive observation. */
export type BoundarySession = {
  readonly status: ElwoodSessionStatus;
  on(event: "activity", handler: (event: ElwoodActivityEvent) => void): Unsubscribe;
  on(
    event: "status",
    handler: (event: { readonly status: ElwoodSessionStatus }) => void,
  ): Unsubscribe;
  on(event: "hook", handler: (event: TurnBoundaryHook) => void): Unsubscribe;
};

/** Passive callers own submission; this observer never sends or replays input. */
export function observeTurnBoundary(session: BoundarySession, closing: AbortSignal) {
  const subscriptions: Unsubscribe[] = [];
  const observer = createBoundaryObserver(closing, undefined, () => {
    for (const off of subscriptions.splice(0)) off();
  });
  if (!closing.aborted)
    subscriptions.push(
      session.on("activity", observer.observeActivity),
      session.on("hook", (event) => observer.observeHook(event, session.status)),
      session.on("status", observer.observeStatus),
    );
  return observer;
}
