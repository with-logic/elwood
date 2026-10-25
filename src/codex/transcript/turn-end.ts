/**
 * Recognizes the committed Codex transcript records that end a turn.
 * Implements PRD §7A.3 for the native question lifecycle (§5.10) and for the shutdown
 * wait on a turn's commit (§5.7, C-LIFE-13), so both read one list.
 */

const turnEndPayloadTypes: ReadonlySet<string> = new Set([
  "task_complete",
  "turn_complete",
  "turn_aborted",
  "turn_failed",
]);

/** Whether a rollout item's `payload` records that a turn ended. */
export function isTurnEndPayload(payload: Readonly<Record<string, unknown>>): boolean {
  const type = payload["type"];
  return typeof type === "string" && turnEndPayloadTypes.has(type);
}
