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
  // A session that terminates before its first ready transition rejects the
  // queued persona; the PRD specifies the undelivered persona is discarded.
  if (persona !== undefined) void session.sendMessage(persona).catch(() => undefined);
  return session;
}
