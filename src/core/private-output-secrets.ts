/**
 * Keeps per-launch credentials available to trusted serializers without exposing them publicly.
 * Implements PRD §12A.3 and C-CLI-12.
 */

const outputSecrets = new WeakMap<object, readonly string[]>();

/** Associate an in-memory session with secrets that must be redacted from normalized output. */
export function registerPrivateOutputSecrets(owner: object, secrets: readonly string[]): void {
  outputSecrets.set(owner, [...secrets]);
}

/** Read a defensive copy of a session's private output-redaction values. */
export function privateOutputSecrets(owner: object): readonly string[] {
  return [...(outputSecrets.get(owner) ?? [])];
}
