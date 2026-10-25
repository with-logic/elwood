/**
 * Codex's turn-rejection evidence, read from its committed transcript (PRD §5.8, C-API-60).
 * Codex fires no `Stop` hook for a turn it rejects (an unknown model, an API error). Its only
 * evidence is the `task_complete` event that carries an `error`, tagged with the turn id the
 * turn's own `UserPromptSubmit` reported. That event ends the turn as a native boundary.
 */

import { isRecord } from "../../core/predicates.ts";
import { boundedDiagnostic, type TurnFailure } from "../../core/simple/boundary-signal.ts";
import { confirmNativeBoundary } from "../../core/simple/native-boundary.ts";

/** A rejected turn's id and failure, or `undefined` for every other transcript item. */
export function codexTurnRejection(
  item: unknown,
): { readonly turnId: string; readonly failure: TurnFailure } | undefined {
  if (!isRecord(item) || item["type"] !== "event_msg") return undefined;
  const payload = item["payload"];
  if (!isRecord(payload) || payload["type"] !== "task_complete") return undefined;
  const error = payload["error"];
  const turnId = payload["turn_id"];
  if (!isRecord(error) || typeof turnId !== "string" || turnId.trim() === "") return undefined;
  const agentError = errorInfoName(error["codex_error_info"]);
  const message =
    boundedDiagnostic(error["message"]) ??
    (agentError === undefined
      ? "Codex rejected the turn."
      : `Codex rejected the turn: ${agentError}`);
  return { turnId, failure: { message, agentError } };
}

/** Ends the rejected turn whose id the item names; any other item is ignored. */
export function confirmCodexRejection(session: object, item: unknown): void {
  const rejection = codexTurnRejection(item);
  if (rejection === undefined) return;
  const signal = { text: "", failure: rejection.failure };
  confirmNativeBoundary(session, { kind: "stop", turnId: rejection.turnId, signal });
}

// Codex's `CodexErrorInfo` is a bare variant name (`"other"`, `"usage_limit_exceeded"`) or a
// one-key object for a variant with fields (`{"http_connection_failed":{...}}`).
function errorInfoName(info: unknown): string | undefined {
  if (!isRecord(info)) return boundedDiagnostic(info);
  const names = Object.keys(info);
  return names.length === 1 ? boundedDiagnostic(names[0]) : undefined;
}
