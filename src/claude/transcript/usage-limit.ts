/** Projects Claude's committed quota denials into a live warning (PRD §5.4, C-API-68). */
import { optional } from "../../core/optional.ts";
import { isNonnegativeSafeInteger, isRecord } from "../../core/predicates.ts";
import { boundedDiagnostic } from "../../core/simple/boundary-signal.ts";
import type { ClaudeUsageLimitWarning } from "../../core/warnings/transcript.ts";
import { type ClaudeDirectRecordSummary, claudeSyntheticModel } from "./summary.ts";

// Bound provider-supplied warning labels to 64 characters for display.
const limitHeading =
  /^You['’]ve (?:hit|reached) your ([A-Za-z0-9][A-Za-z0-9 .'-]{0,63}) limit(?=[ .·]|$)/u;
const nativeLimitCode = /^[a-z0-9_]{1,64}$/u;

type ClaudeUsageLimitSource = {
  readonly elwoodSessionId: string;
  readonly path: string;
  readonly item: unknown;
  readonly turnId?: string;
};

function rejectedQuota(item: unknown): Readonly<Record<string, unknown>> | undefined {
  if (
    !isRecord(item) ||
    item["isSidechain"] === true ||
    item["isApiErrorMessage"] !== true ||
    item["apiError"] !== "usage_limit_reached"
  )
    return undefined;
  const message = item["message"];
  if (!isRecord(message) || message["model"] !== claudeSyntheticModel) return undefined;
  const params = item["apiErrorParams"];
  const info = isRecord(params) ? params["rate_limit_info"] : undefined;
  return isRecord(info) && info["status"] === "rejected" ? info : undefined;
}

/** Use the first nonblank assistant diagnostic, once per qualifying record. */
export function claudeUsageLimitWarning(
  { elwoodSessionId, path, item, turnId }: ClaudeUsageLimitSource,
  summaries: readonly ClaudeDirectRecordSummary[],
): ClaudeUsageLimitWarning | undefined {
  const info = rejectedQuota(item);
  if (info === undefined) return undefined;
  let message: string | undefined;
  for (const summary of summaries) {
    if (summary.kind !== "assistant_message") continue;
    message = boundedDiagnostic(summary.text);
    if (message !== undefined) break;
  }
  if (message === undefined) return undefined;
  const nativeType = info["rateLimitType"];
  const reset = info["resetsAt"];
  return {
    elwoodSessionId,
    agent: "claude",
    source: "transcript",
    code: "usage_limit_reached",
    severity: "warning",
    message,
    transcriptPath: path,
    ...optional(turnId, "turnId"),
    ...optional(limitHeading.exec(message)?.[1], "limitName"),
    ...optional(
      typeof nativeType === "string" && nativeLimitCode.test(nativeType) ? nativeType : undefined,
      "nativeLimitType",
    ),
    ...optional(isNonnegativeSafeInteger(reset) ? reset : undefined, "resetsAtUnixSeconds"),
    raw: "usage_limit_reached",
  };
}
