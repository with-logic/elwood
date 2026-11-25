/** Normalize authoritative harness turn-failure diagnostics (PRD §5.4, C-API-65). */
import { isNonnegativeSafeInteger, isRecord } from "../predicates.ts";

export type ElwoodTurnFailureCategory =
  | "quota_or_credit"
  | "rate_limited"
  | "usage_limit"
  | "model_unavailable"
  | "authentication"
  | "network_or_api"
  | "context_too_long"
  | "unknown";

type NormalizedFailureFields<Category extends ElwoodTurnFailureCategory> = {
  readonly label: Category;
  readonly turnFailure: {
    readonly category: Category;
    readonly message: string;
    readonly disposition: "final";
  } & (Category extends "usage_limit" ? { readonly resetsAtUnixSeconds?: number } : unknown);
};

type NormalizedFailure = {
  [Category in ElwoodTurnFailureCategory]: NormalizedFailureFields<Category>;
}[ElwoodTurnFailureCategory];

/**
 * Payload of `turn_failure.turnFailure`. The diagnostic is bounded to 2,000 UTF-16
 * code units plus an ellipsis. A supplied Unix reset timestamp belongs to a usage limit.
 */
export type ElwoodTurnFailure = NormalizedFailure["turnFailure"];

export type TurnFailureActivity = { readonly kind: "turn_failure" } & NormalizedFailure &
  (
    | {
        readonly agent: "claude";
        readonly source: "hook";
        readonly hookEventName: "StopFailure";
      }
    | {
        readonly agent: "codex";
        readonly source: "transcript";
        readonly turnId: string;
        readonly transcriptPath: string;
      }
  );

const categories = new Map<unknown, ElwoodTurnFailureCategory>([
  ["billing_error", "quota_or_credit"],
  ["credit_balance_too_low", "quota_or_credit"],
  ["insufficient_quota", "quota_or_credit"],
  ["rate_limit", "rate_limited"],
  ["rate_limit_error", "rate_limited"],
  ["rate_limit_exceeded", "rate_limited"],
  ["usage_limit_exceeded", "usage_limit"],
  ["usage_limit_reached", "usage_limit"],
  ["model_not_found", "model_unavailable"],
  ["authentication_failed", "authentication"],
  ["authentication_error", "authentication"],
  ["cloud_credential_error", "authentication"],
  ["invalid_api_key", "authentication"],
  ["oauth_org_not_allowed", "authentication"],
  ["unauthorized", "authentication"],
  ["api_error", "network_or_api"],
  ["http_connection_failed", "network_or_api"],
  ["internal_server_error", "network_or_api"],
  ["overloaded_error", "network_or_api"],
  ["response_stream_connection_failed", "network_or_api"],
  ["response_stream_disconnected", "network_or_api"],
  ["response_too_many_failed_attempts", "network_or_api"],
  ["server_error", "network_or_api"],
  ["server_overloaded", "network_or_api"],
  ["context_length_exceeded", "context_too_long"],
  ["context_window_exceeded", "context_too_long"],
  ["prompt_too_long", "context_too_long"],
]);

/** Read the service error in a checked native diagnostic, encoded or decoded. */
function serviceError(diagnostic: unknown): Readonly<Record<string, unknown>> | undefined {
  let envelope = diagnostic;
  if (typeof diagnostic === "string") {
    if (!diagnostic.trimStart().startsWith("{")) return undefined;
    try {
      envelope = JSON.parse(diagnostic);
    } catch {
      // Malformed diagnostic JSON still supplies the bounded display message.
      return undefined;
    }
  }
  const error = isRecord(envelope) ? envelope["error"] : undefined;
  return isRecord(error) ? error : undefined;
}

const finalFailureBuilder =
  <Category extends Exclude<ElwoodTurnFailureCategory, "usage_limit">>(category: Category) =>
  (message: string) => ({
    label: category,
    turnFailure: { category, message, disposition: "final" as const },
  });

const finalFailureByCategory = {
  quota_or_credit: finalFailureBuilder("quota_or_credit"),
  rate_limited: finalFailureBuilder("rate_limited"),
  usage_limit(
    message: string,
    resetsAtUnixSeconds: unknown,
  ): NormalizedFailureFields<"usage_limit"> {
    return {
      label: "usage_limit",
      turnFailure: {
        category: "usage_limit",
        message,
        disposition: "final",
        ...(isNonnegativeSafeInteger(resetsAtUnixSeconds) ? { resetsAtUnixSeconds } : {}),
      },
    };
  },
  model_unavailable: finalFailureBuilder("model_unavailable"),
  authentication: finalFailureBuilder("authentication"),
  network_or_api: finalFailureBuilder("network_or_api"),
  context_too_long: finalFailureBuilder("context_too_long"),
  unknown: finalFailureBuilder("unknown"),
} satisfies {
  [Category in ElwoodTurnFailureCategory]: (
    message: string,
    resetsAtUnixSeconds: unknown,
  ) => NormalizedFailureFields<Category>;
};

/** Classify the checked native diagnostic independently of the bounded display message. */
export function normalizeFinalTurnFailure({
  displayMessage,
  boundedNativeErrorCode,
  nativeDiagnostic,
}: {
  readonly displayMessage: string;
  readonly boundedNativeErrorCode: string | undefined;
  readonly nativeDiagnostic: unknown;
}): NormalizedFailure {
  const service = serviceError(nativeDiagnostic);
  const category =
    categories.get(service?.["code"]) ??
    categories.get(service?.["type"]) ??
    categories.get(boundedNativeErrorCode) ??
    "unknown";
  return finalFailureByCategory[category](displayMessage, service?.["resets_at"]);
}
