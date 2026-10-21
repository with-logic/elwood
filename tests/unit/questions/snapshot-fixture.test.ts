/** Captured snapshots validate their actual shape before native parser tests. */
import { expect, test } from "vitest";
import { nativeSnapshot, parseNativeSnapshot } from "./helpers.ts";

const raw = {
  lines: ["native frame"],
  cols: 140,
  rows: 45,
  cursorX: 5,
  cursorY: 3,
};

test.each([
  null,
  [],
  { ...raw, lines: undefined },
  { ...raw, lines: [1] },
  { ...raw, cols: "140" },
  { ...raw, rows: Number.NaN },
  { ...raw, cursorX: undefined },
  { ...raw, cursorY: Number.POSITIVE_INFINITY },
  { ...raw, cursorRow: "3" },
  { ...raw, cursorRow: 19.5 },
  { ...raw, cursorVisible: "false" },
  { ...raw, baseY: null },
  { ...raw, viewportY: "0" },
])("rejects malformed captured snapshot %#", (value) => {
  expect(() => parseNativeSnapshot(value)).toThrow("Invalid native question snapshot");
});

test("derives the viewport cursor row and preserves explicit captured cursor fields", () => {
  expect(parseNativeSnapshot({ ...raw, baseY: 9, viewportY: 7 }).cursorRow).toBe(5);
  expect(parseNativeSnapshot({ ...raw, cursorRow: 2, cursorVisible: false })).toMatchObject({
    cursorRow: 2,
    cursorVisible: false,
  });
  expect(nativeSnapshot("review-native")).toMatchObject({ cols: 140, rows: 45, cursorRow: 24 });
});

test("derives captured text from the canonical snapshot lines", () => {
  const lines = ["first native row", "second native row"];
  expect(parseNativeSnapshot({ ...raw, lines })).toMatchObject({
    lines,
    text: lines.join("\n"),
  });
});
