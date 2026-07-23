/**
 * Conformance tests for Claude session-level trust-prompt render-delay behavior.
 * Covers PRD §5.1 (C-CLAUDE-14): a recognized allowlisted trust prompt whose
 * affirmative option has not rendered yet is a TRANSIENT render delay — a
 * fire-once attention with NO durable warning — and is still answered on a later
 * frame once the option paints, leaving no stale record.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession trust-prompt render delay", () => {
  test("C-CLAUDE-14 a not-yet-rendered option emits a TRANSIENT attention, persists NO durable warning", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, autotrust: true });
    const attention: string[] = [];
    const warnings: string[] = [];
    session.on("activity", (e) => e.kind === "attention" && attention.push(e.label));
    session.on("warning", (w) => warnings.push(w.code));
    // A recognized folder-trust HEADER whose affirmative option has not rendered
    // yet — the responder emits a fire-once TRANSIENT attention and keeps watching.
    ptys[0]!.emitData("Do you trust this folder?\r\n1. No, cancel\r\n");
    await expect.poll(() => attention).toContain("workspace_trust");
    // The transient render-delay state emits NO warning: it would otherwise surface a
    // false "not auto-answered" signal even after the prompt is answered on a later frame.
    expect(warnings).not.toContain("trust_prompt_unanswerable");
    expect(ptys[0]!.writes).toEqual([]); // nothing auto-answered yet
  });

  test("C-CLAUDE-14 a partial frame followed by a complete frame ANSWERS the prompt and leaves NO stale warning", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, autotrust: true });
    const warnings: string[] = [];
    session.on("warning", (w) => warnings.push(w.code));
    // Frame 1: header only, option not rendered — transient pending, nothing sent.
    ptys[0]!.emitData("Do you trust this folder?\r\n");
    // Frame 2: the affirmative option now paints — Elwood answers it.
    ptys[0]!.emitData("Do you trust this folder?\r\n1. Yes, I trust this folder\r\n");
    await expect.poll(() => ptys[0]!.writes).toEqual(["1\r"]);
    // No stale wedge warning is emitted after the prompt was successfully answered.
    expect(warnings).not.toContain("trust_prompt_unanswerable");
  });

  test("C-CLAUDE-16 a rejected trust-prompt write stays retryable and warns", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, autotrust: true });
    const warnings: string[] = [];
    session.on("warning", (w) => warnings.push(w.code));
    // The PTY rejects the trust answer write: the prompt must NOT be reported as
    // answered, must stay retryable, and must surface the bounded warning.
    ptys[0]!.failOnWrite = "1\r";
    ptys[0]!.emitData("Do you trust this folder?\r\n1. Yes, I trust this folder\r\n");
    await expect.poll(() => warnings).toContain("startup_prompt_write_failed");
    // Retryable: the next frame re-attempts the answer with a now-succeeding write.
    ptys[0]!.failOnWrite = undefined;
    ptys[0]!.emitData("Do you trust this folder?\r\n1. Yes, I trust this folder\r\n");
    await expect.poll(() => ptys[0]!.writes).toContain("1\r");
  });
});
