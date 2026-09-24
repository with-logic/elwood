/** Each classification owner retains one exact frame (PRD §5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexUpdateFrameClassifier } from "../../src/codex/update/classification.ts";
import * as layout from "../../src/codex/update/layout.ts";

afterEach(() => vi.restoreAllMocks());
test("C-CODEX-12 exact redraws share parsing; new frames and new owners do not", () => {
  const parse = vi.spyOn(layout, "updateDialogOptions");
  const classifier = new CodexUpdateFrameClassifier();
  const ordinary = classifier.read("ordinary output");
  for (let i = 0; i < 100; i++) expect(classifier.read("ordinary output")).toBe(ordinary);
  expect(parse).toHaveBeenCalledTimes(1);
  const update = "1. Update now\n2. Skip";
  const parsed = classifier.read(update);
  expect(parsed.visible).toBe(true);
  expect(classifier.read(update)).toBe(parsed);
  expect(parse).toHaveBeenCalledTimes(2);
  classifier.read("ordinary output");
  expect(parse).toHaveBeenCalledTimes(3);
  expect(new CodexUpdateFrameClassifier().read(update)).not.toBe(parsed);
  expect(parse).toHaveBeenCalledTimes(4);
});
