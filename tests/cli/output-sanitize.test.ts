/**
 * Terminal-control and secret-redaction coverage for CLI protocol text.
 * Implements PRD §12A.3 and C-CLI-12.
 */

import { describe, expect, test } from "vitest";
import { createCliSanitizer } from "../../src/cli/output/sanitize.ts";

describe("CLI output sanitizer", () => {
  test("C-CLI-12 removes complete ANSI, CSI, and OSC sequences", () => {
    const clean = createCliSanitizer();
    const unsafe = [
      "A\u001bcB",
      "\u001b7C\u001b8D",
      "\u001b[31mE\u001b[0mF",
      "\u009b32mG",
      "\u001b]bell-title\u0007H",
      "\u001b]st-title\u001b\\I",
      "\u009d8-bit-title\u009cJ",
    ].join("");
    expect(clean(unsafe)).toBe("ABCDEFGHIJ");
  });

  test("C-CLI-12 strips terminal C0/C1 controls but preserves tab and LF", () => {
    const clean = createCliSanitizer();
    expect(clean("a\rb\bc\u0007d\u0000e\u000bf\u007fg\u0080h\u009fi")).toBe("abcdefghi");
    expect(clean("column\tvalue\nnext")).toBe("column\tvalue\nnext");
  });

  test("C-CLI-12 preserves ordinary Unicode and redacts after controls are removed", () => {
    const clean = createCliSanitizer(["bridge-secret", ""]);
    expect(clean("héllo 🌲 bridge-\u001b[31msecret\u001b[0m")).toBe("héllo 🌲 [REDACTED]");
  });
});
