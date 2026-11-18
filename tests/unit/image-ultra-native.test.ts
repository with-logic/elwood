/** Captured native ultra image confirmation (PRD §5.3, C-API-46/C-E2E-13). */
import { expect, test } from "vitest";
import { imageChipCount } from "../../src/core/images/chip-wait.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

test("C-API-46 C-E2E-13 Codex 0.170.0 ultra image capture confirms one composer chip", () => {
  const frame = capturedFrame("codex-0.170.0/ultra-image-composer");
  expect(frame).toMatch(/^» \[Image #1\]$/m);
  expect(imageChipCount(frame)).toBe(1);
});
