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

test.each([
  false,
  true,
])("C-CODEX-12 reappearing options use their current number (split: %s)", async (split) => {
  const responder = new CodexStartupPromptResponder("selection");
  const writes: string[] = [];
  const write = (key: string) => {
    writes.push(key);
  };
  try {
    const first = responder.handle(`${banner}\n1. Update now\n2. Skip`, write);
    await first.outcomes[0]?.settled;
    responder.handle("› Ready", write);
    if (split) expect(responder.handle(banner, write).outcomes).toEqual([]);
    const rows = "2. Update now\n3. Skip";
    const second = responder.handle(split ? rows : `${banner}\n${rows}`, write);
    await second.outcomes[0]?.settled;
    expect(writes).toEqual(["2", "3"]);
    expect(second.outcomes[0]?.outcome).toMatchObject({ input: "3" });
  } finally {
    responder.dispose();
  }
});
