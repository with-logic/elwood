/** Drive a deferred workspace proof after its answer reservation has ended (C-ATTN-07). */
import { expect, test, vi } from "vitest";
import {
  type ReadChoice,
  WorkspaceTrustAnswers,
} from "../../src/core/dialogs/trust-answer/index.ts";
import type { SelectableOption } from "../../src/core/terminal-options.ts";

test.each([
  "aborted",
  "frame",
] as const)("C-ATTN-07 a valid late proof cannot write after %s", async (category) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const readChoice = vi.fn<ReadChoice<SelectableOption>>();
    const write = vi.fn<(keys: string) => Promise<void>>().mockResolvedValue(undefined);
    const answers = new WorkspaceTrustAnswers({
      currentRequest: () => ({
        gateIdentity: "gate",
        request: { id: "request" },
        choices: [{ id: "choice", choiceIndex: 0, outcome: "affirmative" }],
      }),
      readChoice,
      step: () => ({ keys: "\r", confirm: true }),
      write,
      reconcileDialogEvidence: vi.fn(),
      relinquish: vi.fn(),
    });
    const controller = new AbortController();
    const answer = answers.answer("request", "choice", {
      signal: controller.signal,
      timeoutMs: 25,
    });
    const result = expect(answer).rejects.toMatchObject({ details: { category } });
    const [, , , , finish, proofSignal] = readChoice.mock.calls[0]!;
    if (category === "aborted") controller.abort();
    else await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(proofSignal.aborted).toBe(true);
    finish({
      frame: {},
      option: { style: "numbered", number: "1", label: "Trust", selected: true },
      claim: () => true,
    });
    expect(write).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
