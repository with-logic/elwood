/**
 * Shared fake-session harness for the wait-helper unit tests.
 */

import type { ElwoodActivityEvent, ElwoodActivityKind } from "../../src/core/activity.ts";
import type { ElwoodError } from "../../src/core/errors.ts";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";

type Handler = (event: never) => void;

/** A tiny fake session with a driveable status and event streams. */
export function fakeSession(initial: ElwoodSessionStatus = "running") {
  let status = initial;
  const statusHandlers = new Set<(e: { status: ElwoodSessionStatus }) => void>();
  const activityHandlers = new Set<(e: ElwoodActivityEvent) => void>();
  return {
    get status() {
      return status;
    },
    on(event: "status" | "activity", handler: Handler) {
      const set = event === "status" ? statusHandlers : activityHandlers;
      set.add(handler as never);
      return () => set.delete(handler as never);
    },
    emitStatus(next: ElwoodSessionStatus) {
      status = next;
      for (const handler of statusHandlers) handler({ status: next });
    },
    emitActivity(event: ElwoodActivityEvent) {
      for (const handler of activityHandlers) handler(event);
    },
    statusHandlers,
    activityHandlers,
  };
}

export const activity = (kind: ElwoodActivityKind): ElwoodActivityEvent =>
  ({
    elwoodSessionId: "s1",
    agent: "claude",
    source: "terminal",
    kind,
    label: kind,
  }) satisfies ElwoodActivityEvent;

/** Awaits a rejected wait and returns its Elwood error for code assertions. */
export async function rejection(promise: Promise<unknown>): Promise<ElwoodError> {
  try {
    await promise;
  } catch (error) {
    return error as ElwoodError;
  }
  throw new Error("expected the wait to reject");
}
