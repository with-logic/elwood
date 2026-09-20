/** Snapshot handler-owned data before validation and keep invalid data fail-open (C-HOOK-21). */
import { snapshotJsonData } from "../../core/json-snapshot.ts";

const invalidResponse = Symbol("invalid hook response");

export function snapshotClaudeResponse(value: unknown): unknown {
  const snapshot = snapshotJsonData(value);
  return snapshot.valid ? snapshot.value : invalidResponse;
}
