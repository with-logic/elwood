/** Which startup frames are unrecognized, and when a run of them is reported (C-ATTN-09). */
import { expect, test, vi } from "vitest";
import { createUnrecognizedStartupWatch } from "../../src/runtime/readiness/unrecognized-startup.ts";

const idle = { composer_visible: false, blocking_prompt_visible: false, working_visible: false };
const screen = { text: "Choose the text style" };

function watch(options: { completed?: () => boolean } = {}) {
  const report = vi.fn();
  const configured = vi.fn((frame: string) => frame === "configured");
  const startupScreen = (frame: string) => frame === "boot composer";
  const subject = createUnrecognizedStartupWatch({
    configured,
    startupScreen,
    report,
    completed: options.completed,
  });
  return { subject, report, configured };
}

test("C-ATTN-09 no frame is unrecognized before the deadline or after readiness", () => {
  const { subject, report } = watch();
  expect(subject.classify(idle, false, screen)).toBe(false);
  subject.report(screen.text);
  subject.deadlinePassed();
  expect(subject.classify(idle, false, screen)).toBe(true);
  expect(subject.current()).toBe(true);
  subject.end();
  expect(subject.current()).toBe(false);
  expect(subject.classify(idle, false, screen)).toBe(false);
  subject.report(screen.text);
  expect(report).not.toHaveBeenCalled();
});

test.each([
  ["a recognized dialog", { ...idle, blocking_prompt_visible: true }, false, screen],
  ["startup automation", idle, true, screen],
  ["visible work", { ...idle, working_visible: true }, false, screen],
  ["the configured composer", idle, false, { text: "configured" }],
  ["the adapter's own startup screen", idle, false, { text: "boot composer" }],
] as const)("C-ATTN-09 %s is recognized and ends a run", (_, facts, automation, frame) => {
  const { subject, report } = watch();
  subject.deadlinePassed();
  expect(subject.classify(idle, false, screen)).toBe(true);
  subject.report("first");
  expect(subject.classify(facts, automation, frame)).toBe(false);
  subject.report("recognized");
  expect(subject.classify(idle, false, screen)).toBe(true);
  subject.report("second");
  expect(report.mock.calls).toEqual([["first"], ["second"]]);
});

test("C-ATTN-09 a run of unrecognized frames reports once, with the cols the frame was drawn at", () => {
  const { subject, report, configured } = watch();
  subject.deadlinePassed();
  for (const text of ["frame 1", "frame 2"]) {
    expect(subject.classify(idle, false, { text, cols: 80 })).toBe(true);
    subject.report(text);
  }
  expect(report.mock.calls).toEqual([["frame 1"]]);
  expect(configured).toHaveBeenLastCalledWith("frame 2", 80);
});

test("C-ATTN-09 a blank or incomplete frame is not unrecognized and does not end a run", () => {
  let completed = true;
  const { subject, report } = watch({ completed: () => completed });
  subject.deadlinePassed();
  expect(subject.classify(idle, false, screen)).toBe(true);
  subject.report("first");
  expect(subject.classify(idle, false, { text: " \n " })).toBe(false);
  expect(subject.current()).toBe(false);
  completed = false;
  expect(subject.classify(idle, false, screen)).toBe(false);
  subject.report("incomplete");
  completed = true;
  expect(subject.classify(idle, false, screen)).toBe(true);
  subject.report("same run");
  expect(report.mock.calls).toEqual([["first"]]);
});

test("C-ATTN-09 without adapter screens or a reporter only the configured composer is recognized", () => {
  const subject = createUnrecognizedStartupWatch({ configured: () => false });
  subject.deadlinePassed();
  expect(subject.classify(idle, false, { text: "boot composer" })).toBe(true);
  subject.report("boot composer");
  expect(subject.current()).toBe(true);
});
