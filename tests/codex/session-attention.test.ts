/**
 * Conformance tests for Codex blocked/attention wiring in a real session flow.
 * Covers PRD §5.3 and C-ATTN-03.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const trustPrompt = "Do you trust the contents of this directory?\r\n› 1. Yes, continue\r\n";

describe("CodexSession attention wiring", () => {
  test("C-ATTN-03 an auto-answered Codex trust prompt does not block", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd, autotrust: true });
    const attention: string[] = [];
    session.on("activity", (event) => {
      if (event.kind === "attention") attention.push(event.label);
    });
    ptys[0]!.emitData(trustPrompt);
    // Wait on the processed outcome (the autotrust answer written), not a sleep.
    await vi.waitFor(() => expect(ptys[0]!.writes).toContain("1\r"));
    expect(attention).toEqual([]);
    expect(session.status).not.toBe("blocked");
  });

  test("C-ATTN-03 an unanswered Codex trust prompt blocks with the trust label", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd, autotrust: false });
    const attention: string[] = [];
    session.on("activity", (event) => {
      if (event.kind === "attention") attention.push(event.label);
    });
    ptys[0]!.emitData(trustPrompt);
    await expect.poll(() => session.status).toBe("blocked");
    expect(attention).toEqual(["codex-trust-prompt"]);
    expect(ptys[0]!.writes).toEqual([]);
  });
});
