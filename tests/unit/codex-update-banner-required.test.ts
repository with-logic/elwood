/** Every updater write needs a current native banner (PRD §5.5, C-CODEX-12). */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { CodexUpdatePromptTracker } from "../../src/codex/update/tracker.ts";
import {
  codexOptionStillSafe,
  guardedCodexAutomationWrite,
  writeCodexUpdateSkip,
} from "../../src/codex/update-prompt.ts";

const banner = "Update available! 0.155.1 -> 0.156.1";
const first = `${banner}\n1. Update now\n2. Skip`;
afterEach(() => vi.useRealTimers());

test("C-CODEX-12 same-banner renumbering invalidates the old captured retry before observation", () => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(first);
  const prior = tracker.currentFramePredicate();
  const generation = tracker.currentGeneration;
  const replacement = `${banner}\n1. Update now\n3. Skip`;
  expect(prior(first)).toBe(true);
  expect(prior(replacement)).toBe(false);
  expect(tracker.renewsAttention(replacement)).toBe(true);
  tracker.observe(replacement);
  expect(tracker.hasSupersedingGeneration(generation)).toBe(true);
  expect(prior(replacement)).toBe(false);
  expect(tracker.currentFramePredicate()(replacement)).toBe(true);
  expect(tracker.currentFramePredicate()("2. Skip")).toBe(false);
  tracker.observe("2. Skip");
  expect(tracker.currentFramePredicate()("2. Skip")).toBe(false);
});

test("C-CODEX-12 a renumbered attempt never writes the removed digit on a bannerless repaint", async () => {
  vi.useFakeTimers();
  let frame = first;
  const writes: string[] = [];
  const responder = new CodexStartupPromptResponder();
  const write = (key: string) => void writes.push(key);
  try {
    const old = responder.handle(frame, write, () => frame);
    frame = `${banner}\n1. Update now\n3. Skip`;
    const current = responder.handle(frame, write, () => frame);
    frame = "2. Skip";
    await vi.runAllTimersAsync();
    await Promise.all([...old.outcomes, ...current.outcomes].map((outcome) => outcome.settled));
    expect(writes).toEqual(["2", "3"]);
  } finally {
    responder.dispose();
  }
});

test("C-CODEX-12 removing the safe option revokes its retry without renewing grace", () => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(first);
  const prior = tracker.currentFramePredicate();
  const partial = `${banner}\n1. Update now`;
  expect(prior(partial)).toBe(false);
  expect(tracker.renewsAttention(partial)).toBe(false);
  tracker.observe(partial);
  expect(prior(first)).toBe(false);
  tracker.observe(first);
  expect(tracker.currentFramePredicate()(first)).toBe(true);
});

test.each([
  "2. Skip",
  "1. Update now\n2. Skip",
])("C-CODEX-12 a settled bannerless replacement withholds the pending physical digit: %s", async (replacement) => {
  const writes: string[] = [];
  let frame = first;
  const writer = guardedCodexAutomationWrite(
    {
      sendInput: () => undefined,
      settled: async () => {
        frame = replacement;
        await Promise.resolve();
      },
      renderFailed: false,
    },
    (key) => void writes.push(key),
    () => frame,
  );
  expect(codexOptionStillSafe(first, "2")).toBe(true);
  expect.soft(codexOptionStillSafe(replacement, "2")).toBe(false);
  await expect(writer("2")).resolves.toBe("withheld");
  expect(writes).toEqual([]);
});

test.each([
  "100x3",
  "100x6",
  "100x8",
  "100x30",
])("C-CODEX-12 captured native 0.155.1 %s remains blocking and selects only a visible safe choice", async (size) => {
  vi.useFakeTimers();
  const frame = readFileSync(
    new URL(`../fixtures/codex-0.155.1/update-${size}.txt`, import.meta.url),
    "utf8",
  );
  const writes: string[] = [];
  const responder = new CodexStartupPromptResponder();
  const tracker = new CodexUpdatePromptTracker();
  const safe = size === "100x8" || size === "100x30";
  try {
    expect(tracker.observe(frame)).toBe(true);
    const result = responder.handle(
      frame,
      (key) => void writes.push(key),
      () => frame,
    );
    expect(writes).toEqual(safe ? ["2"] : []);
    responder.dispose();
    await vi.runAllTimersAsync();
    await Promise.all(result.outcomes.map((outcome) => outcome.settled));
  } finally {
    responder.dispose();
  }
});

test("C-CODEX-12 a permissive generation predicate cannot authorize a bannerless retry", async () => {
  vi.useFakeTimers();
  let frame = first;
  const writes: string[] = [];
  const pending = writeCodexUpdateSkip(
    "2",
    (key) => {
      writes.push(key);
      frame = "2. Skip";
    },
    () => frame,
    () => true,
  );
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toBe("cancelled");
  expect(writes).toEqual(["2"]);
});
