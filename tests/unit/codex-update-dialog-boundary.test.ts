/** Current update option blocks exclude stale and replacement rows (PRD §5.5, C-CODEX-12/22). */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { emptyUpdateEvidence, withUpdateFrameEvidence } from "../../src/codex/update/evidence.ts";
import { codexUpdatePromptVisible } from "../../src/codex/update/recognition.ts";
import { safeUpdateOption } from "../../src/codex/update/selection.ts";
import { CodexUpdatePromptTracker } from "../../src/codex/update/tracker.ts";
import { codexOptionStillSafe } from "../../src/codex/update-prompt.ts";

const banner = "Update available! 0.153.3 -> 0.153.4";
const options = "  1. Update now\n  2. Skip";
afterEach(() => vi.useRealTimers());

test("C-CODEX-22 a stale numbered row before the banner cannot authorize a later continuation", () => {
  const frame = `  2. Skip\nOld transcript\n${banner}\n  1. Update now`;
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(frame);
  expect(tracker.currentFramePredicate()("  2. Skip")).toBe(false);
  expect(tracker.observe("  2. Skip")).toBe(false);
  expect(withUpdateFrameEvidence(emptyUpdateEvidence(), frame, true).boundOptions.size).toBe(0);
});

test.each([
  "  2. Skip\nConfirm archive removal?",
  "  2. Skip\n\nConfirm archive removal?\n  3. Later",
  `${banner}\n${options}\nConfirm archive removal?`,
])("C-CODEX-22 trailing replacement content withholds an active retry: %s", async (replacement) => {
  vi.useFakeTimers();
  const responder = new CodexStartupPromptResponder("s1");
  let frame = `${banner}\n${options}`;
  const writes: string[] = [];
  const first = responder.handle(
    frame,
    (key) => {
      writes.push(key);
    },
    () => frame,
  );
  expect(writes).toEqual(["2"]);
  frame = replacement;
  expect(codexOptionStillSafe(frame, "2")).toBe(false);
  await vi.runAllTimersAsync();
  await expect(first.outcomes[0]?.settled).resolves.toBe("cancelled");
  expect(writes).toEqual(["2"]);
});

test("C-CODEX-12 a contiguous option block tolerates padding and a partial banner", () => {
  const tracker = new CodexUpdatePromptTracker();
  expect(tracker.observe(banner)).toBe(true);
  expect(tracker.observe(`${banner}\n\n${options}\n  `)).toBe(true);
  expect(tracker.currentFramePredicate()("\n  2. Skip\n ")).toBe(true);
  expect(codexOptionStillSafe(`${banner}\n\n${options}\n`, "2")).toBe(true);
});

// Rendered from authenticated Codex 0.155.1, with only native terminal resize.
test.each([
  "100x30",
  "100x8",
  "100x6",
  "100x3",
])("C-CODEX-12 native updater %s remains blocking", (size) => {
  const frame = readFileSync(
    new URL(`../fixtures/codex-0.155.1/update-${size}.txt`, import.meta.url),
    "utf8",
  );
  expect(codexUpdatePromptVisible(frame)).toBe(true);
  expect(safeUpdateOption(frame)?.number).toBe(
    size === "100x30" || size === "100x8" ? "2" : undefined,
  );
  expect(withUpdateFrameEvidence(emptyUpdateEvidence(), frame, true).boundOptions.has("0")).toBe(
    false,
  );
});

test.each([
  "2. Skip\nPress enter to continue\n3. Later",
  "2. Skip\n    Confirm archive removal?",
  "2. Skip\nPress enter to continue\nConfirm archive removal?",
])("C-CODEX-22 unknown rows cannot masquerade as a footer or wrapped safe label: %s", (frame) => {
  expect(codexOptionStillSafe(frame, "2")).toBe(false);
});
