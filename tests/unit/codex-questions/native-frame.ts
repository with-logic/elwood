/** Load captured native cursor evidence alongside validated viewport geometry (PRD §4). */
import { isRecord } from "../../../src/core/predicates.ts";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { fixture } from "./helpers.ts";
import { snapshot } from "./snapshot-fixtures.ts";

export function nativeFrame(name: string): QuestionFrame {
  const geometry = snapshot(name);
  const value: unknown = JSON.parse(fixture(name));
  if (
    !isRecord(value) ||
    value["cursorRow"] !== geometry.cursorY ||
    typeof value["cursorVisible"] !== "boolean"
  )
    throw new Error(`Missing native cursor evidence: ${name}`);
  const dimmed = value["cursorCellDimmed"];
  const before = value["cursorLineBefore"];
  if (
    (dimmed !== undefined && typeof dimmed !== "boolean") ||
    (before !== undefined && typeof before !== "string")
  )
    throw new Error(`Invalid editor cursor evidence: ${name}`);
  return {
    ...geometry,
    cursorRow: geometry.cursorY,
    cursorVisible: value["cursorVisible"],
    ...(typeof dimmed === "boolean" ? { cursorCellDimmed: dimmed } : {}),
    ...(typeof before === "string" ? { cursorLineBefore: before } : {}),
  };
}
