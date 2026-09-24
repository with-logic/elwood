/** Live recognition shares captured native updater banners (PRD §5.5, C-CODEX-12). */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { codexUpdatePromptVisible } from "../../src/codex/update/recognition.ts";

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
