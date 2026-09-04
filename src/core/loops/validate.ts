/**
 * Runtime validation for recurring-loop creation requests.
 * Implements PRD §5.9 and C-LOOP-03/C-LOOP-10.
 */

import { elwoodError } from "../errors.ts";
import {
  MAX_LOOP_INTERVAL_MS,
  MAX_LOOP_MESSAGE_BYTES,
  MIN_LOOP_INTERVAL_MS,
  MIN_LOOP_MESSAGE_BYTES,
} from "./constants.ts";
import type { ElwoodLoopRequest } from "./types.ts";

function invalidLoop(field: "request" | "message" | "intervalMs"): never {
  throw elwoodError("invalid_loop", "Loop request is invalid.", { field });
}

export function validateLoopMessage(message: unknown): string {
  if (typeof message !== "string") invalidLoop("message");
  const bytes = Buffer.byteLength(message, "utf8");
  if (bytes < MIN_LOOP_MESSAGE_BYTES || bytes > MAX_LOOP_MESSAGE_BYTES) {
    invalidLoop("message");
  }
  return message;
}

export function validateLoopIntervalMs(intervalMs: unknown): number {
  if (
    typeof intervalMs !== "number" ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < MIN_LOOP_INTERVAL_MS ||
    intervalMs >= MAX_LOOP_INTERVAL_MS
  ) {
    invalidLoop("intervalMs");
  }
  return intervalMs;
}

export function validateLoopRequest(request: unknown): ElwoodLoopRequest {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    invalidLoop("request");
  }
  const candidate = request as Readonly<Record<string, unknown>>;
  const message = validateLoopMessage(candidate["message"]);
  if (candidate["mode"] === "fixed") {
    return {
      mode: "fixed",
      intervalMs: validateLoopIntervalMs(candidate["intervalMs"]),
      message,
    };
  }
  if (candidate["mode"] === "idle" && !("intervalMs" in candidate)) {
    return { mode: "idle", message };
  }
  return invalidLoop("request");
}
