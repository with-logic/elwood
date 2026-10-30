/**
 * The shared scan for a marker split across chunks: the probe's start line (PRD §9.2,
 * C-PERF-05) and the e2e home guard's stop marker (PRD §12, C-E2E-24) both rely on it.
 */

import { expect, test } from "vitest";
import { homeGuardStopMarker, watchForStopMarker } from "../../src/runtime/home-guard/index.ts";

const offsets = Array.from({ length: homeGuardStopMarker.length - 1 }, (_, i) => i + 1);

test.each(offsets)("C-E2E-24 finds the stop marker split after byte %i, once", (offset) => {
  const watcher = watchForStopMarker();
  const text = `profile output ${homeGuardStopMarker}: reason\n`;
  const at = "profile output ".length + offset;
  expect(watcher.feed(Buffer.from(text.slice(0, at)))).toBe(false);
  expect(watcher.feed(Buffer.from(text.slice(at)))).toBe(true);
  expect(watcher.seen).toBe(true);
  expect(watcher.feed(Buffer.from(homeGuardStopMarker))).toBe(false);
});

test("C-E2E-24 a marker missing its last byte is not the marker", () => {
  const watcher = watchForStopMarker();
  watcher.feed(Buffer.from(homeGuardStopMarker.slice(0, -1)));
  watcher.feed(Buffer.from("x"));
  expect(watcher.seen).toBe(false);
});
