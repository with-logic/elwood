/** Shared hook shape limits and JSON data safety (PRD §6.4, C-HOOK-18/21). */
import { snapshotJsonData } from "./json-snapshot.ts";

export function isBoundedJsonShape(value: unknown): boolean {
  return snapshotJsonData(value).valid;
}
