/**
 * Typed wait helpers over a session's status and activity event streams.
 * Resolve immediately when the condition already holds, on a future event
 * otherwise, reject on timeout, and reject when the session terminates first.
 * Implements PRD §5.3 and C-API-34.
 */

import type { ElwoodActivityEvent } from "./activity.ts";
import { elwoodError } from "./errors.ts";
import { terminalStatuses as terminalWaitStatuses } from "./status-categories.ts";
import type { ElwoodSessionStatus, Unsubscribe } from "./types.ts";

export type StatusWaitIo = {
  readonly current: () => ElwoodSessionStatus;
  readonly onStatus: (handler: (status: ElwoodSessionStatus) => void) => Unsubscribe;
};

export type ActivityWaitIo = {
  readonly current: () => ElwoodSessionStatus;
  readonly onActivity: (handler: (event: ElwoodActivityEvent) => void) => Unsubscribe;
  readonly onStatus: (handler: (status: ElwoodSessionStatus) => void) => Unsubscribe;
};

const defaultWaitTimeoutMs = 60_000;

/** A session view sufficient to build both wait helpers from `on`/`status`. */
export type WaitableSession = {
  readonly status: ElwoodSessionStatus;
  on(
    event: "status",
    handler: (event: { readonly status: ElwoodSessionStatus }) => void,
  ): Unsubscribe;
  on(event: "activity", handler: (event: ElwoodActivityEvent) => void): Unsubscribe;
};

export function sessionWaitForStatus(
  session: WaitableSession,
  match: (status: ElwoodSessionStatus) => boolean,
  timeoutMs?: number,
): Promise<ElwoodSessionStatus> {
  return waitForStatus(
    {
      current: () => session.status,
      onStatus: (handler) => session.on("status", (event) => handler(event.status)),
    },
    match,
    timeoutMs,
  );
}

export function sessionWaitForActivity(
  session: WaitableSession,
  match: (event: ElwoodActivityEvent) => boolean,
  timeoutMs?: number,
): Promise<ElwoodActivityEvent> {
  return waitForActivity(
    {
      current: () => session.status,
      onActivity: (handler) => session.on("activity", handler),
      onStatus: (handler) => session.on("status", (event) => handler(event.status)),
    },
    match,
    timeoutMs,
  );
}

export function waitForStatus(
  io: StatusWaitIo,
  match: (status: ElwoodSessionStatus) => boolean,
  timeoutMs = defaultWaitTimeoutMs,
): Promise<ElwoodSessionStatus> {
  const current = io.current();
  // A throwing predicate rejects the wait instead of escaping synchronously.
  let currentMatched: boolean;
  try {
    currentMatched = match(current);
  } catch (error) {
    return Promise.reject(asError(error));
  }
  if (currentMatched) return Promise.resolve(current);
  // Already terminal and unmatched: reject now rather than waiting out the
  // timeout for an event that can never arrive.
  if (terminalWaitStatuses.has(current)) return Promise.reject(terminated(current));
  return new Promise((resolve, reject) => {
    const done = settler(reject, "status", timeoutMs);
    const off = io.onStatus((status) => {
      let matched: boolean;
      try {
        matched = match(status);
      } catch (error) {
        return done.finish(() => reject(asError(error)), off, timer);
      }
      if (matched) return done.finish(() => resolve(status), off, timer);
      // A terminal status the caller was not waiting for ends the wait.
      if (terminalWaitStatuses.has(status))
        done.finish(() => reject(terminated(status)), off, timer);
    });
    const timer = done.arm(off);
  });
}

export function waitForActivity(
  io: ActivityWaitIo,
  match: (event: ElwoodActivityEvent) => boolean,
  timeoutMs = defaultWaitTimeoutMs,
): Promise<ElwoodActivityEvent> {
  if (terminalWaitStatuses.has(io.current())) {
    return Promise.reject(terminated(io.current()));
  }
  return new Promise((resolve, reject) => {
    const done = settler(reject, "activity", timeoutMs);
    const offActivity = io.onActivity((event) => {
      let matched: boolean;
      try {
        matched = match(event);
      } catch (error) {
        return done.finish(() => reject(asError(error)), offAll, timer);
      }
      if (matched) done.finish(() => resolve(event), offAll, timer);
    });
    const offStatus = io.onStatus((status) => {
      if (terminalWaitStatuses.has(status))
        done.finish(() => reject(terminated(status)), offAll, timer);
    });
    const offAll = () => {
      offActivity();
      offStatus();
    };
    const timer = done.arm(offAll);
  });
}

function settler(reject: (error: Error) => void, label: "status" | "activity", timeoutMs: number) {
  let settled = false;
  return {
    finish(run: () => void, off: Unsubscribe, timer: ReturnType<typeof setTimeout>): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      run();
    },
    arm(off: Unsubscribe): ReturnType<typeof setTimeout> {
      const timer = setTimeout(() => {
        const message = `Timed out waiting for ${label} after ${timeoutMs} ms.`;
        this.finish(() => reject(elwoodError("wait_timeout", message)), off, timer);
      }, timeoutMs);
      timer.unref?.();
      return timer;
    },
  };
}

function terminated(status: ElwoodSessionStatus): Error {
  return elwoodError("session_not_running", `Session reached ${status} before the wait resolved.`);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
