/** Validate captured terminal geometry before using it as native evidence (PRD §4). */
import { isRecord, isStringArray } from "../../../src/core/predicates.ts";
import type { TerminalSnapshot } from "../../../src/terminal/headless.ts";
import { fixture } from "./helpers.ts";

export function snapshot(name: string): TerminalSnapshot {
  const value: unknown = JSON.parse(fixture(name));
  if (
    !isRecord(value) ||
    typeof value["cols"] !== "number" ||
    !Number.isInteger(value["cols"]) ||
    value["cols"] <= 0 ||
    typeof value["rows"] !== "number" ||
    !Number.isInteger(value["rows"]) ||
    value["rows"] <= 0 ||
    typeof value["cursorX"] !== "number" ||
    !Number.isInteger(value["cursorX"]) ||
    value["cursorX"] < 0 ||
    value["cursorX"] >= value["cols"] ||
    typeof value["cursorY"] !== "number" ||
    !Number.isInteger(value["cursorY"]) ||
    value["cursorY"] < 0 ||
    value["cursorY"] >= value["rows"] ||
    !isStringArray(value["lines"]) ||
    value["lines"].length !== value["rows"] ||
    typeof value["text"] !== "string" ||
    value["text"] !== value["lines"].join("\n")
  )
    throw new Error(`Invalid terminal capture: ${name}`);
  return {
    cols: value["cols"],
    rows: value["rows"],
    cursorX: value["cursorX"],
    cursorY: value["cursorY"],
    lines: value["lines"],
    text: value["text"],
  };
}
