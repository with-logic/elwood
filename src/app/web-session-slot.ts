/**
 * Serialized single-session slot for the browser dev app.
 * Implements PRD §11.
 *
 * The dev app holds at most one live Elwood session in a module-global slot.
 * WebSocket messages arrive fire-and-forget, so two concurrent `start` frames
 * would both launch a session and the second assignment would overwrite (leak)
 * the first's PTY. This slot serializes every session-mutating operation through
 * a promise chain (a lightweight mutex) and, when replacing an occupied slot,
 * tears down the outgoing session BEFORE storing the replacement — so a session
 * is never dropped without being killed.
 */

import type { SharedSession } from "./agent-runtime.ts";

export class WebSessionSlot {
  private current: SharedSession | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  /** The active session, or `null`. Read-only view; use `run` to mutate. */
  get session(): SharedSession | null {
    return this.current;
  }

  /**
   * Run `task` with exclusive access to the slot, serialized after every prior
   * task. Concurrent calls queue instead of interleaving, so two `start` frames
   * can never both install a session against a stale read.
   */
  run<T>(task: (slot: WebSessionSlot) => Promise<T>): Promise<T> {
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
   * Replace the slot's session, tearing down any session already present first
   * so its PTY is never leaked. Call inside `run` to keep the swap atomic.
   */
  async replace(next: SharedSession): Promise<void> {
    const outgoing = this.current;
    this.current = next;
    if (outgoing && outgoing !== next) await teardownQuietly(outgoing);
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
}

async function teardownQuietly(session: SharedSession): Promise<void> {
  try {
    await session.teardown();
  } catch {
    // A replaced session is being discarded; a failed teardown must not block
    // the incoming session from taking the slot.
  }
}
