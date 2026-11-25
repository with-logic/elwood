/** Projects Claude's committed quota denials into a live warning (PRD §5.4, C-API-68). */
import { optional } from "../../core/optional.ts";
import { isNonnegativeSafeInteger, isRecord } from "../../core/predicates.ts";
import { boundedDiagnostic } from "../../core/simple/boundary-signal.ts";
import type { ClaudeUsageLimitWarning } from "../../core/warnings/transcript.ts";

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
  if (!isRecord(message) || message["model"] !== "<synthetic>") return undefined;
  const params = item["apiErrorParams"];
  const info = isRecord(params) ? params["rate_limit_info"] : undefined;
  return isRecord(info) && info["status"] === "rejected" ? info : undefined;
}

/** `text` is the single assistant summary from this already-parsed native record. */
export function claudeUsageLimitWarning(
  { elwoodSessionId, path, item, turnId }: ClaudeUsageLimitSource,
  text: string,
): ClaudeUsageLimitWarning | undefined {
  const info = rejectedQuota(item);
  if (info === undefined) return undefined;
  const message = boundedDiagnostic(text);
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
