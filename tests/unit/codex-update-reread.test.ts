/**
 * A frame read again with no output from Codex is no frame Codex drew. An update skip
 * retypes its key only on a frame Codex drew after it. The repaint a skip owns still ends
 * on a configured composer read again, since an idle Codex draws nothing more (PRD §5.5,
 * C-CODEX-12, C-CODEX-27).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { firstKeyDelayMs } from "../../src/codex/update-prompt.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const prompt = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
const capture = (name: string) => capturedFrame(`codex-0.172.0/update/${name}`).trimEnd();

test("C-CODEX-12 a prompt read again with no output from Codex gets no second key", async () => {
  const responder = new CodexStartupPromptResponder("s1");
  let frame = prompt;
  const writes: string[] = [];
  const write = (input: string) => {
    writes.push(input);
  };
  responder.handle(prompt, write, () => frame);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(writes).toEqual(["2"]);
  // Elwood's view of the prompt changed, but Codex has drawn nothing since the key.
  frame = `${prompt}\n\n  Press enter to continue`;
  responder.handle(frame, write, () => frame, write, undefined, { drawn: false });
  await vi.runAllTimersAsync();
  expect(writes).toEqual(["2"]);
  responder.dispose();
});

test("C-CODEX-27 the repaint a skip owns ends on its configured composer read again", async () => {
  const configured = capture("start-skipped-composer");
  // The live clearance verifies the configured composer on a settled frame only. Codex draws
  // it while no frame is settled, and the frame is then read again.
  let settled = true;
  const clearance = (text: string) => settled && text === configured;
  const responder = new CodexStartupPromptResponder("s1", false, undefined, clearance, () => false);
  let frame = capture("offer-standalone-100x30");
  const writes: string[] = [];
  const write = (input: string) => {
    writes.push(input);
  };
  const read = () => frame;
  responder.handle(frame, write, read);
  await vi.advanceTimersByTimeAsync(firstKeyDelayMs + 50);
  expect(writes).toEqual(["2"]);
  frame = capture("start-boot-composer");
  responder.handle(frame, write, read);
  expect(responder.inputBlocking).toBe(true); // Codex is repainting after the key
  settled = false;
  frame = configured;
  responder.handle(frame, write, read);
  expect(responder.inputBlocking).toBe(true);
  settled = true;
  responder.handle(frame, write, read, write, undefined, { drawn: false });
  expect(responder.inputBlocking).toBe(false);
  responder.dispose();
});
