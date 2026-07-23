/**
 * Strict validation of browser dev-app client messages.
 * Implements PRD §11: the dev app must reject malformed or unknown control
 * messages with a clear error instead of silently mishandling them (an unknown
 * type must NOT be able to tear down the active session — teardown requires its
 * own explicit `teardown` message).
 */

import type { AgentKind } from "./agent-runtime.ts";
import type { ClientMessage } from "./web-messages.ts";

/**
 * Parse and validate a raw JSON frame into a `ClientMessage`. Parses to
 * `unknown`, then checks each discriminated variant's required and optional
 * fields. Any unknown `type`, missing required field, or wrong field type is
 * rejected with a descriptive error rather than returned as a partial message.
 */
export function parseClientMessage(raw: string): ClientMessage {
  const parsed = decodeJson(raw);
  // Distinguish the two malformed shapes (the parser promises descriptive errors):
  // a non-object payload vs a valid object that lacks a string `type` discriminant.
  if (!isRecord(parsed)) throw new Error("Client message must be a JSON object.");
  if (typeof parsed["type"] !== "string") {
    throw new Error('Client message requires a string "type" field.');
  }
  return validateByType(parsed, parsed["type"]);
}

function validateByType(record: Record<string, unknown>, type: string): ClientMessage {
  switch (type) {
    case "start":
      return validateStart(record);
    case "prompt":
    case "keys":
      return { type, value: requireString(record, "value", type) };
    case "resize":
      return {
        type,
        cols: requireNumber(record, "cols", type),
        rows: requireNumber(record, "rows", type),
      };
    case "stop":
    case "kill":
    case "teardown":
      return { type };
    default:
      throw new Error(`Unknown client message type: ${type}`);
  }
}

function validateStart(record: Record<string, unknown>): ClientMessage {
  return {
    type: "start",
    cwd: requireString(record, "cwd", "start"),
    cols: requireNumber(record, "cols", "start"),
    rows: requireNumber(record, "rows", "start"),
    ...optionalAgent(record),
    ...optionalString(record, "stateDir", "start"),
    ...optionalString(record, "elwoodSessionId", "start"),
  };
}

function optionalAgent(record: Record<string, unknown>): { readonly agent?: AgentKind } {
  const value = record["agent"];
  if (value === undefined) return {};
  if (value !== "claude" && value !== "codex") {
    throw new Error('start message "agent" must be "claude" or "codex".');
  }
  return { agent: value };
}

// The output key IS the input key (both call sites passed them identically), so a
// single `key` parameter avoids the two drifting apart.
function optionalString<K extends string>(
  record: Record<string, unknown>,
  key: K,
  type: string,
): Partial<Record<K, string>> {
  const value = record[key];
  if (value === undefined) return {};
  if (typeof value !== "string") {
    throw new Error(`${type} message "${key}" must be a string.`);
  }
  return { [key]: value } as Record<K, string>;
}

function requireString(record: Record<string, unknown>, key: string, type: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${type} message requires string "${key}".`);
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string, type: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${type} message requires numeric "${key}".`);
  }
  return value;
}

function decodeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Client message is not valid JSON.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
