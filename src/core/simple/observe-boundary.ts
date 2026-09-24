/** Observe an internal turn through completeness and trailing drain (PRD §5.8, C-API-48/50). */

import type { ElwoodActivityEvent } from "../activity/index.ts";
import { elwoodError } from "../errors.ts";
import { terminalStatuses } from "../status-categories.ts";
import type { ElwoodSessionStatus, Unsubscribe } from "../types.ts";
import { boundaryExpectation } from "./boundary-signal.ts";
import { toTurnEvent } from "./events.ts";
import { gateForTurn } from "./turn/defaults.ts";
import { TurnBoundary } from "./turn-boundary.ts";
import { defaultBoundarySignal, type TurnBoundaryHook } from "./turn-types.ts";

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

/** Passive observation: the caller owns submission; this never sends or replays input. */
export function observeTurnBoundary(session: BoundarySession, closing: AbortSignal) {
  const gate = gateForTurn({});
  let started = false;
  let sawReady = false;
  const boundary = new TurnBoundary(() => {
    gate.dispose();
    offActivity();
    offHook();
    offStatus();
    closing.removeEventListener("abort", onClosing);
  });
  const ready = () => {
    if (!started) return;
    sawReady = true;
    gate.observeReady();
    boundary.armDrain();
  };
  const discard = () => {
    gate.end();
    boundary.reach();
  };
  const offActivity = session.on("activity", (event) => {
    const content = toTurnEvent(event);
    if (content) {
      started = true;
      gate.push(content);
      if (content.type === "text") gate.observeText(content.text);
    }
    if (boundary.draining) boundary.armDrain();
  });
  const offHook = session.on("hook", (event) => {
    const signal = defaultBoundarySignal(event);
    gate.expectText(boundaryExpectation(signal));
    if (signal !== undefined) {
      started = true;
      if (session.status === "ready") ready();
    }
  });
  const offStatus = session.on("status", ({ status }) => {
    if (status === "running") started = true;
    if (terminalStatuses.has(status)) discard();
    else if (status === "ready") ready();
  });
  const onClosing = () => discard();
  closing.addEventListener("abort", onClosing, { once: true });
  if (closing.aborted) onClosing();
  gate.done().then(
    () => boundary.reach(),
    () => {
      boundary.markConsumerFailed();
      if (sawReady) boundary.armDrain();
    },
  );
  // Internal turn output still flows through public activity; discard only this collector's copy.
  void (async () => {
    for await (const event of gate.drain()) void event;
  })().catch(() => undefined);
  return {
    promise: boundary.promise.then(() => {
      if (closing.aborted) throw elwoodError("session_not_running", "Session is closing.");
    }),
    discard,
  };
}
