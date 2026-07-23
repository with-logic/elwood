/**
 * Serialized single-session slot for the browser dev app.
 * Implements PRD §11.
 *
 * The dev app holds at most one live Elwood session. The slot is per app instance
 * (one is constructed in each `createWebDevApp`), NOT a module global. WebSocket
 * messages arrive fire-and-forget, so two concurrent `start` frames would both
 * launch a session and the second assignment would overwrite (leak) the first's
 * PTY. This slot serializes every session-mutating operation through a promise
 * chain (a lightweight mutex). On `replace`, the incoming session is installed
 * first and the outgoing one is then torn down (a DEFERRED teardown, so the slot
 * never reads as occupied by a session that is mid-teardown) — the outgoing PTY is
 * still always killed, and a teardown failure is REPORTED (not silently dropped)
 * so a stuck process tree stays visible.
 */

import type { SharedSession } from "./agent-runtime.ts";

/** Reports a discarded session's teardown failure so it is not silently lost. */
export type TeardownErrorReporter = (elwoodSessionId: string, error: unknown) => void;

export class WebSessionSlot {
  private current: SharedSession | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly onTeardownError: TeardownErrorReporter | undefined;

  // `onTeardownError` surfaces a replaced session's teardown failure (optional; when
  // omitted the failure is still contained, matching the prior behavior for callers
  // that do not wire a reporter).
  constructor(onTeardownError?: TeardownErrorReporter) {
    this.onTeardownError = onTeardownError;
  }

  /** The active session, or `null`. Read-only view; use `run` to mutate. */
  get session(): SharedSession | null {
    return this.current;
  }

  /**
   * Run `task` with exclusive access to the slot, serialized after every prior
   * task. Concurrent calls queue instead of interleaving, so two `start` frames
   * can never both install a session against a stale read. Once the slot is CLOSED
   * (shutdown began), new work is refused so it cannot install a session after the
   * final teardown — which would resurrect/leak a PTY past shutdown.
   */
  run<T>(task: (slot: WebSessionSlot) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The session slot is shutting down."));
    const result = this.tail.then(() => task(this));
    // Keep the chain alive even when a task rejects; callers handle their own errors.
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** The current session, or throw when none is running. Call inside `run`. */
  require(): SharedSession {
    if (!this.current) throw new Error("No Elwood session is running.");
    return this.current;
  }

  /**
   * Replace the slot's session. The replacement is installed first, then any prior
   * session is torn down so its PTY is never leaked. A teardown failure is reported
   * (not swallowed) so it cannot block the incoming session or vanish silently. Call
   * inside `run` to keep the swap atomic.
   */
  async replace(next: SharedSession): Promise<void> {
    const outgoing = this.current;
    this.current = next;
    if (outgoing && outgoing !== next) await this.teardownQuietly(outgoing);
  }

  private async teardownQuietly(session: SharedSession): Promise<void> {
    try {
      await session.teardown();
    } catch (error) {
      // A replaced session is being discarded; a failed teardown must not block the
      // incoming session, but it MUST be reported so a stuck PTY/process tree stays
      // visible. The report is CONTAINED: a throwing reporter (e.g. broadcast during a
      // socket-close race) must not reject replace() after the new session is installed,
      // which would leave it unwired (wireSession/announceSession never run).
      try {
        this.onTeardownError?.(session.elwoodSessionId, error);
      } catch {
        // A throwing reporter must not reject replace() or unwire the new session.
      }
    }
  }

  /** Clear the slot when `session` is still the active one. Call inside `run`. */
  clearIf(session: SharedSession): void {
    if (this.current === session) this.current = null;
  }

  /** Detach and return the active session without tearing it down. */
  take(): SharedSession | null {
    const active = this.current;
    this.current = null;
    return active;
  }

  /**
   * Close the slot for shutdown: refuse all future `run` work, wait for any IN-FLIGHT
   * slot task (e.g. a start that is mid-`startSession`) to settle, then detach and
   * return whatever session is installed. Serializing behind the current tail closes
   * the race where a resolving start installs a session AFTER a bare `take()` already
   * ran — the returned session (possibly just-installed) is the caller's to tear down.
   */
  async closeAndTake(): Promise<SharedSession | null> {
    this.closed = true;
    // `this.tail` is already `.catch`-wrapped in `run`, so awaiting it never rejects;
    // it just lets any in-flight task (e.g. a mid-flight start) finish installing first.
    await this.tail;
    return this.take();
  }
}
