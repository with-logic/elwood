/** Observe an internal turn through completeness and trailing drain (PRD §5.8, C-API-48/50). */

import type { ElwoodActivityEvent } from "../activity/index.ts";
import { elwoodError } from "../errors.ts";
import { terminalStatuses } from "../status-categories.ts";
import type { ElwoodSessionStatus } from "../types.ts";
import { boundaryExpectation } from "./boundary-signal.ts";
import { toTurnEvent } from "./events.ts";
import { gateForTurn } from "./turn/defaults.ts";
import { TurnBoundary } from "./turn-boundary.ts";
import { defaultBoundarySignal, type TurnBoundaryHook } from "./turn-types.ts";

/**
 * Owned mode requires prior native acceptance; only private confirmed outcomes supply Stop.
 * Owned mode ignores public hooks; only confirmStop supplies an authoritative outcome.
 * Pre-Stop ready cannot be attributed: subsequent status is insufficient until fresh idle
 * confirmation. Explicit interrupted idle may settle accepted work without a Stop hook.
 */
export type BoundaryOwnership = {
  readonly accepted: () => boolean;
};

/** Passive observation: the caller owns submission; this never sends or replays input. */
export function createBoundaryObserver(
  closing: AbortSignal,
  ownership: BoundaryOwnership | undefined,
  onDispose: () => void,
) {
  const gate = gateForTurn({});
  let started = false;
  let ownedStop = false;
  let sawReady = false;
  let readyBeforeStop = false;
  const boundary = new TurnBoundary(() => {
    gate.dispose();
    onDispose();
    closing.removeEventListener("abort", onClosing);
  });
  const ready = (confirmed = false, interrupted = false) => {
    if (ownership) {
      if (!ownership.accepted()) return;
      if (!(ownedStop || interrupted)) {
        readyBeforeStop = true;
        return;
      }
      if (readyBeforeStop && !confirmed) return;
      started = true;
    }
    if (!started) return;
    sawReady = true;
    gate.observeReady();
    boundary.armDrain();
  };
  const discard = () => {
    gate.end();
    boundary.reach();
  };
  const observeActivity = (event: ElwoodActivityEvent) => {
    if (ownership && !ownership.accepted()) return;
    const content = toTurnEvent(event);
    if (content) {
      started = true;
      gate.push(content);
      if (content.type === "text") gate.observeText(content.text);
    }
    if (boundary.draining) boundary.armDrain();
  };
  const observeHook = (event: TurnBoundaryHook, status: ElwoodSessionStatus) => {
    if (ownership) return;
    const signal = defaultBoundarySignal(event);
    gate.expectText(boundaryExpectation(signal));
    if (signal !== undefined) {
      started = true;
      if (status === "ready") ready();
    }
  };
  const observeStatus = ({ status }: { readonly status: ElwoodSessionStatus }) => {
    if (status === "running") started = true;
    if (terminalStatuses.has(status)) discard();
    else if (status === "ready") ready();
  };
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
    observeActivity,
    observeHook,
    observeStatus,
    promise: boundary.promise.then(() => {
      if (closing.aborted) throw elwoodError("session_not_running", "Session is closing.");
    }),
    discard,
    /** Only accepted owned work may record a confirmed outcome. */
    confirmStop: (text: string, requireFreshIdle: boolean) => {
      if (!ownership?.accepted()) return;
      ownedStop = true;
      readyBeforeStop ||= requireFreshIdle;
      gate.expectText(text);
      started = true;
    },
    /** Call only for a fresh idle frame; interrupted additionally attests hookless termination. */
    confirmIdle: (options: { readonly interrupted?: boolean }) =>
      ready(true, options.interrupted === true),
  };
}
