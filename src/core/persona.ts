/**
 * Persona enqueue helper shared by adapter start paths.
 * Implements PRD §5.1, §5.5, and C-API-21.
 */

import type { ElwoodAgentSession } from "./agent-session.ts";
import { terminalStatuses } from "./status-categories.ts";

type MessageTarget = Pick<ElwoodAgentSession, "sendMessage" | "status" | "on">;
const personas = new WeakMap<object, Promise<void>>();

/** Ergonomic collection starts after startup persona input has finished or been discarded. */
export function personaBoundary(session: object): Promise<void> | undefined {
  return personas.get(session);
}

export function queuePersonaMessage<T extends MessageTarget>(
  session: T,
  persona: string | undefined,
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
    // Wait for submission first: initial readiness releases the persona, not its caller.
    const boundary = session
      .sendMessage(persona)
      .then(() => settledPersona(session))
      .catch(() => undefined);
    personas.set(session, boundary);
    void boundary.then(() => personas.delete(session));
  }
  return session;
}

function settledPersona(session: MessageTarget): Promise<void> {
  const settled = () => session.status === "ready" || terminalStatuses.has(session.status);
  if (settled()) return Promise.resolve();
  // No turn deadline: persona work can take arbitrarily long. Shutdown releases the waiter.
  return new Promise((resolve) => {
    const off = session.on("status", () => {
      if (!settled()) return;
      off();
      resolve();
    });
  });
}
