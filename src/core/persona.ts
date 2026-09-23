/**
 * Persona enqueue helper shared by adapter start paths.
 * Implements PRD §5.1, §5.5, and C-API-21.
 */

import { observeTurnBoundary } from "./simple/observe-boundary.ts";
import type { TurnSession } from "./simple/turn-types.ts";

type PersonaBoundaryTarget = TurnSession;
const personaBoundariesBySession = new WeakMap<object, Promise<void>>();

/** Ergonomic collection starts after startup persona input has finished or been discarded. */
export function personaBoundary(session: object): Promise<void> | undefined {
  return personaBoundariesBySession.get(session);
}

export function queuePersonaMessage<T extends PersonaBoundaryTarget>(
  session: T,
  persona: string | undefined,
  closing: AbortSignal,
): T {
  // The queued persona is a floated submission: the start path returns the
  // session before it dispatches, so its promise has no caller to reject into.
  // The expected rejection is `session_not_running` (the session terminated
  // before its first ready transition) — the PRD specifies the undelivered
  // persona is discarded. Any other rejection (a PTY write failure) has no
  // reporting channel here either and would otherwise surface as an unhandled
  // rejection that terminates the host, so it is contained the same way; the
  // failure remains observable through the session's own status/warning events.
  if (persona !== undefined) {
    const observer = observeTurnBoundary(session, closing);
    // Initial readiness releases submission; only completion and transcript drain release callers.
    const boundary = Promise.all([
      session.sendMessage(persona).catch(observer.discard),
      observer.promise,
    ]).then(() => undefined);
    personaBoundariesBySession.set(session, boundary);
    const forget = () => personaBoundariesBySession.delete(session);
    void boundary.then(forget, forget);
  }
  return session;
}
