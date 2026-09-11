/**
 * Unit coverage for the UTF-8 code-point boundary helper the bounded probe uses to
 * truncate captured output (PRD §9.2, C-PERF-03).
 */

import { describe, expect, test } from "vitest";
import { completeUtf8Length } from "../../src/core/utf8.ts";

describe("C-PERF-03 UTF-8 boundary truncation", () => {
  const euro = Buffer.from("€", "utf8"); // 3 bytes: e2 82 ac

  test("keeps a buffer that ends on a complete code point", () => {
    const full = Buffer.concat([euro, euro]);
    expect(completeUtf8Length(full)).toBe(full.length);
  });

  test("keeps a buffer ending in ASCII", () => {
    expect(completeUtf8Length(Buffer.from("ab", "utf8"))).toBe(2);
  });

  test("drops an incomplete 3-byte trailing sequence", () => {
    expect(completeUtf8Length(Buffer.concat([euro, euro.subarray(0, 2)]))).toBe(3);
  });

  test("drops an incomplete 4-byte trailing sequence", () => {
    const emoji = Buffer.from("😀", "utf8"); // 4 bytes: f0 9f 98 80
    expect(completeUtf8Length(emoji.subarray(0, 3))).toBe(0);
  });

  test("drops an incomplete 2-byte trailing sequence", () => {
    const eacute = Buffer.from("é", "utf8"); // 2 bytes: c3 a9
    expect(completeUtf8Length(eacute.subarray(0, 1))).toBe(0);
  });

  test("keeps everything when there is no lead byte (all continuation bytes)", () => {
    expect(completeUtf8Length(Buffer.from([0x80, 0x80]))).toBe(2);
  });
});
