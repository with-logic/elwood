/** Current update blocks exclude replacement rows from retries (PRD §5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { codexOptionStillSafe } from "../../src/codex/update-prompt.ts";

const banner = "Update available! 0.153.3 -> 0.153.4";
const options = "  1. Update now\n  2. Skip";
afterEach(() => vi.useRealTimers());

test.each([
  "  2. Skip\nConfirm archive removal?",
  "  2. Skip\n\nConfirm archive removal?\n  3. Later",
  `${banner}\n${options}\nConfirm archive removal?`,
  `${banner}\nConfirm archive removal?\n${options}`,
])("C-CODEX-12 trailing replacement content withholds an active retry: %s", async (replacement) => {
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

test.each([
  "Later",
  "Not now",
  "Update now",
])("C-CODEX-12 bannerless %s alone is not an update continuation", (label) => {
  expect(codexOptionStillSafe(`2. ${label}`, "2")).toBe(false);
});
