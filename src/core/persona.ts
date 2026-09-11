/**
 * Persona enqueue helper shared by adapter start paths.
 * Implements PRD §5.1, §5.5, and C-API-21.
 */

type MessageTarget = {
  sendMessage(message: string): Promise<void>;
};

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
  if (persona !== undefined) void session.sendMessage(persona).catch(() => undefined);
  return session;
}
