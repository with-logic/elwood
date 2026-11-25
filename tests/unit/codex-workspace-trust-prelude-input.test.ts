/** Verify the startup prelude input observer stops reading the terminal at readiness (C-TRUST-01). */
import { expect, test, vi } from "vitest";
import { trackWorkspacePreludeInput } from "../../src/codex/workspace-trust/prelude-input.ts";
import { trustView } from "../../src/core/trust/view.ts";
import { setupTerminalPty } from "../helpers/terminal-pty.ts";

test("C-TRUST-01 ending startup prevents further native prelude input observation", () => {
  const read = vi.fn(() => {
    throw new Error("startup terminal should no longer be read");
  });
  const prelude = trackWorkspacePreludeInput(read);
  prelude.end();
  prelude.record();
  expect(read).not.toHaveBeenCalled();
});

test("C-TRUST-01 ending startup discards an already pending prelude claim", async () => {
  const { terminal, emit } = setupTerminalPty();
  const prelude = trackWorkspacePreludeInput(() => terminal);
  try {
    emit("Folder access");
    await terminal.settled();
    prelude.consumePendingClaim({ kind: "unknown" });
    prelude.record();
    prelude.end();

    emit("\x1b[2J\x1b[HTrust this folder?");
    await terminal.settled();
    const view = trustView("Trust this folder?", "codex", () => false);
    expect(view.kind).toBe("candidate");
    expect(prelude.consumePendingClaim(view)).toBe(false);
  } finally {
    terminal.dispose();
  }
});
