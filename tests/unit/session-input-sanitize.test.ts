/**
 * Unit tests for bracketed-paste sanitization: an embedded end sentinel or control byte in
 * caller/model text can never escape paste mode into live keystrokes. Covers PRD §5.3, C-API-40.
 */

import { describe, expect, test } from "vitest";
import { sanitizePasteText } from "../../src/core/input/index.ts";

describe("sanitizePasteText", () => {
  test("C-API-40 strips an embedded bracketed-paste end sentinel so it cannot escape paste mode", () => {
    // A message with ESC[201~ then a live Enter would otherwise end the paste
    // early and submit into a dialog; the ESC is removed, leaving inert text.
    const evil = "approve?[201~\rmalicious";
    const clean = sanitizePasteText(evil);
    // The ESC is gone, so the sentinel can no longer terminate paste mode; the
    // now-inert "[201~" text and the carriage return remain paste DATA.
    expect(clean.includes("")).toBe(false);
    expect(clean).toBe("approve?[201~\rmalicious");
  });

  test("C-API-40 preserves tab, newline, and carriage return as multi-line text", () => {
    expect(sanitizePasteText("a\tb\nc")).toBe("a\tb\nc");
  });

  test("C-API-40 strips other C0/C1 control bytes", () => {
    expect(sanitizePasteText("ab")).toBe("ab");
  });
});
