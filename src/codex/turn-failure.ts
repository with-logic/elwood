/**
 * Reads Codex's own evidence that it REJECTED a turn (PRD §12A.5, C-API-57).
 *
 * Codex reports a rejected turn only in its rollout transcript: an `event_msg` whose payload is
 * `task_complete` carrying an `error` object (and a null `last_agent_message`). It fires NO
 * turn-boundary `Stop` hook on that path — verified against codex-cli 0.155.0, where a bogus
 * `--model` turn delivers `SessionStart` and `UserPromptSubmit` and nothing else — so this
 * evidence can only reach the runner through activity, never through `readBoundarySignal`.
 *
 * The PRESENCE of the `error` payload is the signal. Neither an empty response nor a null
 * `last_agent_message` is evidence of failure (PRD §12A.3 allows a legitimately empty successful
 * reply), and `codex_error_info` is DIAGNOSTIC only: the same rejection path reports `"other"`
 * for an unsupported model and `"usage_limit_exceeded"` for quota, so keying on its value would
 * miss most real failures.
 */

import { isRecord } from "../core/predicates.ts";
import type { FailureEvidenceReader, TurnFailure } from "../core/simple/turn-types.ts";

/** Cap on the reason text carried out of the transcript, so a huge payload stays bounded. */
const maxMessageLength = 2_000;

export const codexFailureEvidence: FailureEvidenceReader = (event) => {
  const payload = asRecord(asRecord(event.raw)?.["payload"]);
  if (payload?.["type"] !== "task_complete") return undefined;
  const error = asRecord(payload["error"]);
  // PRESENCE of the error payload is the whole test: a `task_complete` WITHOUT one is an
  // ordinary successful turn, including one whose `last_agent_message` is null.
  if (!error) return undefined;
  return failure(error);
};

function failure(error: Readonly<Record<string, unknown>>): TurnFailure {
  const info = error["codex_error_info"];
  return {
    message: reason(error["message"]),
    ...(typeof info === "string" ? { info } : {}),
  };
}

/**
 * The human-readable reason. Codex wraps a server rejection as a JSON envelope
 * (`{"type":"error","status":400,"error":{"message":"…"}}`), so unwrap the innermost
 * `error.message` when one parses; otherwise keep the raw string. A non-string/absent
 * message still yields a truthful generic reason rather than an empty error.
 */
function reason(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "Codex rejected the turn.";
  // A provider rejection can carry a multi-megabyte payload. Only attempt the nested JSON
  // unwrap while the raw string is within the cap; above it, truncate without parsing rather
  // than spending the work on a value that is about to be cut down anyway.
  if (value.length > maxMessageLength) return bounded(value);
  return bounded(unwrapJsonMessage(value) ?? value);
}

function unwrapJsonMessage(value: string): string | undefined {
  try {
    const inner = asRecord(asRecord(JSON.parse(value))?.["error"])?.["message"];
    return typeof inner === "string" && inner.length > 0 ? inner : undefined;
  } catch {
    return undefined;
  }
}

function bounded(message: string): string {
  return message.length <= maxMessageLength ? message : `${message.slice(0, maxMessageLength)}…`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}
