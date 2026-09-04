/**
 * Runtime validation for canonical persisted recurring-loop definitions.
 * Implements PRD §8.2 and C-LOOP-04/C-LOOP-07/C-LOOP-11/C-LOOP-13/C-LOOP-21.
 */

import {
  IDLE_LOOP_INTERVAL_MS,
  LOOP_EXPIRATION_MS,
  MAX_ACTIVE_LOOPS,
  MAX_LOOP_INTERVAL_MS,
  MAX_LOOP_JITTER_MS,
  MAX_LOOP_MESSAGE_BYTES,
  MIN_LOOP_INTERVAL_MS,
  MIN_LOOP_MESSAGE_BYTES,
} from "../core/loops/constants.ts";
import type { PersistedLoopDefinition } from "./loop-store.ts";
import { isRecord } from "./validate-predicates.ts";

export const LOOP_SIDECAR_SCHEMA_VERSION = 1;

/** Return fresh allowlisted definitions, or null when any part is unsafe. */
export function validateLoopSidecar(value: unknown): readonly PersistedLoopDefinition[] | null {
  if (!isRecord(value) || value["schemaVersion"] !== LOOP_SIDECAR_SCHEMA_VERSION) return null;
  const loops = value["loops"];
  if (!Array.isArray(loops) || loops.length > MAX_ACTIVE_LOOPS) return null;
  const result: PersistedLoopDefinition[] = [];
  const ids = new Set<string>();
  for (const value of loops) {
    const definition = validateDefinition(value);
    if (definition === null || ids.has(definition.id)) return null;
    ids.add(definition.id);
    result.push(definition);
  }
  return result;
}

function validateDefinition(value: unknown): PersistedLoopDefinition | null {
  if (!isRecord(value)) return null;
  const common = validateCommon(value);
  if (common === null) return null;
  if (value["mode"] === "fixed") {
    const intervalMs = value["intervalMs"];
    if (!(validInterval(intervalMs) && validJitter(common.jitterMs, intervalMs))) return null;
    return { ...common, mode: "fixed", intervalMs };
  }
  if (
    value["mode"] !== "idle" ||
    "intervalMs" in value ||
    !validJitter(common.jitterMs, IDLE_LOOP_INTERVAL_MS)
  ) {
    return null;
  }
  return { ...common, mode: "idle" };
}

type CommonDefinition = Omit<PersistedLoopDefinition, "mode" | "intervalMs">;

function validateCommon(value: Readonly<Record<string, unknown>>): CommonDefinition | null {
  const id = value["id"];
  const message = value["message"];
  const jitterMs = value["jitterMs"];
  const createdAt = value["createdAt"];
  const expiresAt = value["expiresAt"];
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof message !== "string" ||
    !validMessageSize(message) ||
    !safeTimestamp(createdAt) ||
    !safeTimestamp(expiresAt) ||
    expiresAt !== createdAt + LOOP_EXPIRATION_MS ||
    typeof jitterMs !== "number" ||
    !Number.isSafeInteger(jitterMs)
  ) {
    return null;
  }
  return { id, message, jitterMs, createdAt, expiresAt };
}

function validMessageSize(message: string): boolean {
  const bytes = Buffer.byteLength(message, "utf8");
  return bytes >= MIN_LOOP_MESSAGE_BYTES && bytes <= MAX_LOOP_MESSAGE_BYTES;
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validInterval(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_LOOP_INTERVAL_MS &&
    value < MAX_LOOP_INTERVAL_MS
  );
}

function validJitter(value: number, intervalMs: number): boolean {
  const cap = Math.min(Math.floor(intervalMs / 10), MAX_LOOP_JITTER_MS);
  return value >= 0 && value <= cap;
}
