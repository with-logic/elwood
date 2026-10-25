/**
 * The real-CLI e2e suite's bounded steps (PRD §12, C-E2E-03) fail under their own label,
 * with the session's status and screen tail, instead of running into the runner's
 * unlabeled timeout. The e2e runs only reach their success paths, so the failure paths
 * are pinned here against a session double.
 */

import { describe, expect, test } from "vitest";
import { type StepSession, sendWithin, waitForCondition } from "../e2e/bounded-steps.ts";

function session(sendMessage: StepSession["sendMessage"]): StepSession {
  const lines = Array.from({ length: 14 }, (_, index) => `row ${index + 1}`);
  return {
    status: "running",
    terminal: { snapshot: () => ({ text: `${lines.join("\n")}\n\n` }) },
    sendMessage,
  };
}

const neverSends = () => new Promise<void>(() => undefined);

describe("bounded e2e steps", () => {
  test("waitForCondition resolves once the condition holds", async () => {
    let calls = 0;
    await expect(
      waitForCondition(session(neverSends), () => ++calls > 1, "second poll", 5_000),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  test("waitForCondition fails under its label with the status and the screen's tail", async () => {
    const failure = waitForCondition(session(neverSends), () => false, "never", 10);
    await expect(failure).rejects.toThrow(/^Timed out waiting for never \(status running\)/);
    await expect(failure).rejects.toThrow(/screen:\nrow 3\n[\s\S]*\nrow 14$/);
    await expect(failure).rejects.not.toThrow(/row 2\n/);
  });

  test("sendWithin resolves once the submission dispatches", async () => {
    const sent: string[] = [];
    const sends = (text: string) => {
      sent.push(text);
      return Promise.resolve();
    };
    await expect(sendWithin(session(sends), "ONE", "ONE", 5_000)).resolves.toBeUndefined();
    expect(sent).toEqual(["ONE"]);
  });

  test("sendWithin fails under its label when the submission never dispatches", async () => {
    const failure = sendWithin(session(neverSends), "ONE", "ONE", 10);
    await expect(failure).rejects.toThrow(/^Timed out sending ONE \(status running\); screen:/);
  });
});
