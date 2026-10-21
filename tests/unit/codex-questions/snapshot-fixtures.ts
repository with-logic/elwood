/** Validate captured terminal geometry before using it as native evidence (PRD §4). */
import { isRecord, isStringArray } from "../../../src/core/predicates.ts";
import type { TerminalSnapshot } from "../../../src/terminal/headless.ts";
import { fixture } from "./helpers.ts";

export function snapshot(name: string): TerminalSnapshot {
  const value: unknown = JSON.parse(fixture(name));
  if (!isRecord(value)) throw new Error(`Invalid terminal capture: ${name}`);
  const { cols, rows, cursorX, cursorY, lines, text } = value;
  if (
    typeof cols !== "number" ||
    !Number.isInteger(cols) ||
    cols <= 0 ||
    typeof rows !== "number" ||
    !Number.isInteger(rows) ||
    rows <= 0
  )
    throw new Error(`Invalid terminal capture: ${name}`);
  if (
    typeof cursorX !== "number" ||
    !Number.isInteger(cursorX) ||
    cursorX < 0 ||
    cursorX >= cols ||
    typeof cursorY !== "number" ||
    !Number.isInteger(cursorY) ||
    cursorY < 0 ||
    cursorY >= rows
  )
    throw new Error(`Invalid terminal capture: ${name}`);
  if (!isStringArray(lines) || lines.length !== rows)
    throw new Error(`Invalid terminal capture: ${name}`);
  if (typeof text !== "string" || text !== lines.join("\n"))
    throw new Error(`Invalid terminal capture: ${name}`);
  return { cols, rows, cursorX, cursorY, lines, text };
}
