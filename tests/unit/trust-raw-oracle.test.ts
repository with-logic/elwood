/** Independent native e2e visibility survives production parser drift (C-E2E-09). */
import { expect, test } from "vitest";
import { trustPromptVisible as recognized } from "../../src/core/trust/responder.ts";
import {
  completeFolderTrustScreenVisible,
  folderTrustScreenVisible,
  trustPromptVisible,
} from "../e2e/trust-screens.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

test.each([
  ["claude", "Do you trust this folder?\nNew upstream copy\n❯ Yes\n  No"],
  ["codex", "Hooks need review\nNew upstream copy\n› 1. Trust all and continue"],
  ["codex", "Do you trust the contents of this directory?\nNew upstream copy\n1. Yes"],
] as const)("C-E2E-09 raw %s oracle still sees a production false negative", (agent, frame) => {
  expect(recognized(frame, agent)).toBe(false);
  expect(trustPromptVisible(frame, agent)).toBe(true);
});

test("C-E2E-09 the raw Codex oracle sees the captured folder-access gate", () => {
  // Codex 0.156.1 introduced this gate and 0.164 still draws it.
  expect(trustPromptVisible(capturedFrame("codex-0.156.1/folder-access"), "codex")).toBe(true);
});

test("C-E2E-09 a wrapped or wording-drifted complete Claude gate is not a silent skip", () => {
  const frame =
    "Accessing workspace:\n/tmp/project\nIs this a project you\nrecognize?\n❯ No\n  Yes";
  expect(folderTrustScreenVisible(frame)).toBe(true);
  expect(completeFolderTrustScreenVisible(frame)).toBe(true);
  expect(completeFolderTrustScreenVisible("Accessing workspace:")).toBe(false);
  expect(folderTrustScreenVisible("Ready")).toBe(false);
  expect(trustPromptVisible("Ready", "claude")).toBe(false);
  expect(trustPromptVisible("Ready", "codex")).toBe(false);
});
