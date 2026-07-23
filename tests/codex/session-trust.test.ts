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

  test("C-CODEX-17 a rejected trust-prompt write stays retryable and warns", async () => {
    installFakes();
    const session = await startCodex({ cwd: tempDir(), autotrust: true });
    const warnings: string[] = [];
    session.on("warning", (event) => warnings.push(event.code));
    // The PTY rejects the trust answer write: the prompt stays retryable and
    // surfaces the bounded warning rather than being reported as answered.
    ptys[0]!.failOnWrite = "1\r";
    ptys[0]!.emitData("Do you trust the contents of this directory?\r\n› 1. Yes, continue");
    await expect.poll(() => warnings).toContain("startup_prompt_write_failed");
    // Retryable: a later frame re-attempts the answer with a now-succeeding write.
    ptys[0]!.failOnWrite = undefined;
    ptys[0]!.emitData("Do you trust the contents of this directory?\r\n› 1. Yes, continue");
    await expect.poll(() => ptys[0]!.writes).toContain("1\r");
  });

  test("C-CODEX-15 a not-yet-rendered option emits a TRANSIENT attention, persists NO durable warning", async () => {
    installFakes();
    const session = await startCodex({ cwd: tempDir(), autotrust: true });
    const attention: string[] = [];
    const warnings: string[] = [];
    session.on("activity", (e) => e.kind === "attention" && attention.push(e.label));
    session.on("warning", (event) => warnings.push(event.code));
    // A recognized directory-trust HEADER whose affirmative option has not rendered
    // yet: the responder emits a fire-once TRANSIENT attention and keeps watching.
    ptys[0]!.emitData("Do you trust the contents of this directory?\r\n› 1. No, quit");
    await flushTerminal();
    expect(attention).toContain("workspace_trust");
    // No wedge warning — the pending state is transient (would answer on a later
    // frame), so it must not emit a false "not auto-answered" notice.
    expect(warnings).not.toContain("trust_prompt_unanswerable");
    expect(ptys[0]!.writes).toEqual([]); // nothing auto-answered yet
  });

  test("C-API-28 a throwing option_pending listener does not abort the frame's terminal:data", async () => {
    // Mirror of the Claude frame regression: the `option_pending` render-delay attention
    // emits public activity on the hot frame path; a throwing listener there must be
    // CONTAINED so the same frame still delivers terminal:data (readiness/blocking too).
    installFakes();
    const session = await startCodex({ cwd: tempDir(), autotrust: true });
    let terminalData = 0;
    session.on("activity", (e) => {
      if (e.kind === "attention" && e.label === "workspace_trust") throw new Error("listener boom");
    });
    session.on("terminal:data", () => {
      terminalData += 1;
    });
    ptys[0]!.emitData("Do you trust the contents of this directory?\r\n› 1. No, quit");
    await flushTerminal();
    expect(terminalData).toBeGreaterThan(0); // the frame was not aborted by the throw
  });

  test("C-CODEX-15 a partial frame followed by a complete frame ANSWERS the prompt, no stale warning", async () => {
    installFakes();
    const session = await startCodex({ cwd: tempDir(), autotrust: true });
    const warnings: string[] = [];
    session.on("warning", (event) => warnings.push(event.code));
    // Frame 1: header only — transient pending, nothing sent.
    ptys[0]!.emitData("Do you trust the contents of this directory?");
    await flushTerminal();
    // Frame 2: the affirmative now paints — Elwood answers it.
    ptys[0]!.emitData("Do you trust the contents of this directory?\r\n› 1. Yes, continue");
    await flushTerminal();
    expect(ptys[0]!.writes).toEqual(["1\r"]);
    expect(warnings).not.toContain("trust_prompt_unanswerable");
  });
});
