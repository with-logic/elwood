/** Reject unsupported Codex choice cardinality before writing input (C-ATTN-07). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexWorkspaceTrustDiscovery } from "../../src/codex/workspace-trust/discovery.ts";
import type { ElwoodDialogChoice } from "../../src/core/dialogs/types.ts";
import { resetFakes } from "./helpers.ts";
import { setupWorkspaceAnswer } from "./workspace-trust-answer-helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

type FormatChoices = (choice: ElwoodDialogChoice) => readonly ElwoodDialogChoice[];

test.each<{ name: string; choices: FormatChoices }>([
  { name: "one choice", choices: (choice) => [choice] },
  {
    name: "three choices",
    choices: (choice) => [choice, { id: "second", label: "Quit" }, { id: "third", label: "Other" }],
  },
  {
    name: "a missing first entry",
    choices: (choice) => Object.assign(new Array<ElwoodDialogChoice>(2), { 1: choice }),
  },
  {
    name: "a missing second entry",
    choices: (choice) => Object.assign(new Array<ElwoodDialogChoice>(2), { 0: choice }),
  },
])("C-ATTN-07 refuses a request with $name before writing a key", async ({ choices }) => {
  const { session, pty, request } = await setupWorkspaceAnswer();
  const accept = request.choices[0]!;
  vi.spyOn(
    CodexWorkspaceTrustDiscovery.prototype,
    "currentRequestWithDeclineOutcome",
    "get",
  ).mockReturnValue({ request: { ...request, choices: choices(accept) }, declineOutcome: "exit" });
  try {
    await expect(
      session.answerDialog(request.id, accept.id, { timeoutMs: 300 }),
    ).rejects.toMatchObject({
      code: "dialog_not_found",
    });
    expect(pty.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});
