/**
 * Codex session-level trust-prompt behavior.
 * Covers PRD §5.5 (C-CODEX-06, C-CODEX-11, C-CODEX-15) and C-ATTN-03.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
const flushTerminal = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("CodexSession trust prompts", () => {
  test("C-CODEX-06 C-CODEX-15 trusts hooks via the TUI prompt and does NOT block", async () => {
    // autotrust OFF, but hook trust (Elwood's own integration) is still answered
    // — and because it is answered it must never block (C-ATTN-03).
    installFakes({ supportsHookTrustBypass: false });
    const session = await startCodex({ cwd: tempDir() });
    const attention: string[] = [];
    session.on("activity", (e) => e.kind === "attention" && attention.push(e.label));
    ptys[0]!.emitData("Hooks need review\r\n  1. Review hooks\r\n› 2. Trust all and continue");
    await flushTerminal();
    expect(ptys[0]!.writes).toEqual(["2\r"]);
    expect(attention).toEqual([]);
    expect(session.status).not.toBe("blocked");
  });

  test("C-CODEX-11 autotrust answers Codex directory prompts", async () => {
    installFakes();
    const session = await startCodex({ cwd: tempDir(), autotrust: true });
    const activity: string[] = [];
    session.on("activity", (event) => activity.push(`${event.kind}:${event.label}`));
    ptys[0]!.emitData("Do you trust the contents of this directory?\r\n› 1. Yes, continue");
    await flushTerminal();
    expect(ptys[0]!.writes).toEqual(["1\r"]);
    expect(activity).toContain("startup_prompt:workspace_trust");
  });
});
