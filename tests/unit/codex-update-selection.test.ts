/** Update option ordering at initial dispatch and every retry (PRD §5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { writeCodexUpdateSkip } from "../../src/codex/update-prompt.ts";

const banner = "Update available! 0.153.3 -> 0.153.4";
afterEach(() => vi.useRealTimers());

test.each([
  ["1. Update now\n2. Skip\n3. Skip until next version", "2"],
  ["1. Skip backup\n2. Update now", undefined],
  ["1. Skip backup\n2. Update now\n3. Later", "3"],
  ["1. Update now and skip setup", undefined],
  ["1. Update now\n2. Update now and skip setup\n3. Skip", "3"],
  ["1. Update now", undefined],
])("C-CODEX-12 initial dispatch selects only a safe post-action option: %s", async (rows, expected) => {
  const responder = new CodexStartupPromptResponder("selection");
  const writes: string[] = [];
  const result = responder.handle(`${banner}\n${rows}`, (key) => {
    writes.push(key);
  });
  await Promise.all(result.outcomes.map((outcome) => outcome.settled));
  expect(writes).toEqual(expected === undefined ? [] : [expected]);
  expect(
    result.outcomes.map(({ outcome }) =>
      outcome.kind === "attempted" ? outcome.input : undefined,
    ),
  ).toEqual(writes);
  responder.dispose();
});

test("C-CODEX-12 a banner-less continuation still selects its safe option", async () => {
  const responder = new CodexStartupPromptResponder("selection");
  responder.handle(banner, () => {});
  const writes: string[] = [];
  const result = responder.handle("2. Skip\n3. Skip until next version", (key) => {
    writes.push(key);
  });
  await Promise.all(result.outcomes.map((outcome) => outcome.settled));
  expect(writes).toEqual(["2"]);
  responder.dispose();
});

test.each([
  ["1. Skip backup\n2. Update now", ["2"]],
  ["1. Skip backup\n2. Update now\n3. Later", ["2", "3"]],
  ["1. Update now and skip setup", ["2"]],
])("C-CODEX-12 retry applies the ordering rule to its current frame: %s", async (replacement, expected) => {
  vi.useFakeTimers();
  let frame = `${banner}\n1. Update now\n2. Skip`;
  const writes: string[] = [];
  const completion = writeCodexUpdateSkip(
    "2",
    (key) => {
      writes.push(key);
      frame = writes.length === 1 ? `${banner}\n${replacement}` : "› Ready";
    },
    () => frame,
  );
  await vi.runAllTimersAsync();
  await completion;
  expect(writes).toEqual(expected);
});
