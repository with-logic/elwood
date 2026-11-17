/** Live recognition shares captured native updater banners (PRD §5.5, C-CODEX-12). */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { codexUpdatePromptVisible } from "../../src/codex/update/recognition.ts";
import { safeUpdateOption } from "../../src/codex/update/selection.ts";

test.each([
  "100x30",
  "100x8",
  "100x6",
  "100x3",
])("C-CODEX-12 native %s banner stays blocking before safe options are visible", (size) => {
  const frame = readFileSync(
    new URL(`../fixtures/codex-0.155.1/update-${size}.txt`, import.meta.url),
    "utf8",
  );
  expect(codexUpdatePromptVisible(frame)).toBe(true);
});

test("C-CODEX-12 the reported 0.167.2 to 0.169.0 offer selects Skip instead of Update now", () => {
  const frame =
    "✨ Update available! 0.167.2 → 0.169.0\n› 1. Update now\n  2. Skip\n  3. Skip until next version";
  expect(codexUpdatePromptVisible(frame)).toBe(true);
  expect(safeUpdateOption(frame)).toEqual({ number: "2", label: "Skip" });
});
