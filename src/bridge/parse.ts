/**
 * Bridge request parsing and fail-open result helpers.
 * Implements PRD §6.2 and §6.3.
 */

import { inertRecord } from "../core/inert-record.ts";
import type { HookErrorEvent } from "../core/types.ts";
import type { BridgeProcessResult } from "./types.ts";

export type BridgeMessage =
  | {
      readonly kind: "ok";
      readonly token: string;
      readonly elwoodSessionId?: string;
      readonly input: string;
    }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "malformed" };

export function parseBridgeMessage(data: string): BridgeMessage {
  try {
    const parsed = JSON.parse(data) as {
      readonly token?: unknown;
      readonly elwoodSessionId?: unknown;
      readonly input?: unknown;
    };
    if (parsed.token === undefined) return { kind: "unauthenticated" };
    if (typeof parsed.token === "string" && typeof parsed.input === "string") {
      return {
        kind: "ok",
        token: parsed.token,
        input: parsed.input,
        ...(typeof parsed.elwoodSessionId === "string"
          ? { elwoodSessionId: parsed.elwoodSessionId }
          : {}),
      };
    }
    return { kind: "malformed" };
  } catch {
    return { kind: "malformed" };
  }
}

export function parseHookInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function hookEventNameFrom(input: unknown): HookErrorEvent["hookEventName"] {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return typeof record["hook_event_name"] === "string"
    ? (record["hook_event_name"] as HookErrorEvent["hookEventName"])
    : "Unknown";
}

export function noDecision(): BridgeProcessResult {
  return inertRecord({ exitCode: 0, stdout: "", stderr: "" });
}
