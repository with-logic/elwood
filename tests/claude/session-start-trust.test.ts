/**
 * Conformance tests for Claude session-level trust-prompt render-delay behavior.
 * Covers PRD §5.1 (C-CLAUDE-14): a recognized allowlisted trust prompt whose
 * affirmative option has not rendered yet is a TRANSIENT render delay — a
 * fire-once attention with NO durable warning — and is still answered on a later
 * frame once the option paints, leaving no stale record.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import {
  claudeBody,
  claudeComposer,
  claudeTrust,
  claudeTty,
  tty,
} from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSessionApi trust-prompt render delay", () => {
  test("C-CLAUDE-10 autotrust navigates the current cursor prompt before reporting it answered", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, autotrust: true });
    const activity: string[] = [];
    session.on("activity", (event) => activity.push(`${event.kind}:${event.label}`));
    ptys[0]!.emitData(
      `Quick safety check: Is this a project you created or one you trust?\r\n${tty(claudeBody)}\r\n\r\n❯ No, exit\r\n  Yes, I trust this folder`,
    );
    await vi.waitFor(() => expect(ptys[0]!.writes).toEqual(["\u001b[B"]));
    ptys[0]!.emitData(
      `\u001b[2J\u001b[HQuick safety check: Is this a project you created or one you trust?\r\n${tty(claudeBody)}\r\n\r\n  No, exit\r\n❯ Yes, I trust this folder`,
    );
    await vi.waitFor(() => expect(ptys[0]!.writes).toEqual(["\u001b[B", "\r"]));
    ptys[0]!.emitData(`\u001b[2J\u001b[H${claudeTty(claudeComposer)}`);
    await vi.waitFor(() => expect(activity).toContain("startup_prompt:workspace_trust"));
  });

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
    ptys[0]!.emitData(`${tty(claudeTrust)}\r\n1. No, cancel\r\n`);
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
    // Frame 1: header and body, option not rendered — transient pending, nothing sent.
    ptys[0]!.emitData(`${tty(claudeTrust)}\r\n`);
    // Frame 2: the affirmative option now paints — Elwood answers it.
    ptys[0]!.emitData(`${tty(claudeTrust)}\r\n1. Yes, I trust this folder\r\n`);
    await expect.poll(() => ptys[0]!.writes).toEqual(["1\r"]);
    // No stale wedge warning is emitted after the prompt was successfully answered.
    expect(warnings).not.toContain("trust_prompt_unanswerable");
  });

  test("C-API-28 a throwing option_pending listener does not abort the frame's readiness/terminal:data", async () => {
    // The `option_pending` outcome (a render-delay trust attention) emits public activity
    // on the hot frame path. A throwing listener there must be CONTAINED so the rest of
    // the SAME frame still runs — readiness/blocking observation and terminal:data. Drive
    // it end-to-end through the real session frame, not just the helper.
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, autotrust: true });
    let terminalData = 0;
    session.on("activity", (e) => {
      if (e.kind === "attention" && e.label === "workspace_trust") throw new Error("listener boom");
    });
    session.on("terminal:data", () => {
      terminalData += 1;
    });
    // An option-less frame -> an option_pending attention whose listener throws. The frame
    // must not abort: terminal:data for this frame must STILL deliver.
    ptys[0]!.emitData(`${tty(claudeTrust)}\r\n`);
    await expect.poll(() => terminalData).toBeGreaterThan(0);
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
    ptys[0]!.emitData(`${tty(claudeTrust)}\r\n1. Yes, I trust this folder\r\n`);
    await expect.poll(() => warnings).toContain("startup_prompt_write_failed");
    // Retryable: the next frame re-attempts the answer with a now-succeeding write.
    ptys[0]!.failOnWrite = undefined;
    ptys[0]!.emitData(`\u001b[2J\u001b[H${tty(claudeTrust)}\r\n1. Yes, I trust this folder\r\n`);
    await expect.poll(() => ptys[0]!.writes).toContain("1\r");
  });

  test("C-TRUST-01 a header without its native body holds input untyped until the body paints", async () => {
    installFakes();
    const session = await startClaude({ cwd: tempDir(), autotrust: true });
    const frames: string[] = [];
    session.on("terminal:data", (event) => frames.push(event.data));
    const attention: string[] = [];
    session.on("activity", (e) => e.kind === "attention" && attention.push(e.label));
    const queued = session.sendMessage("held");
    ptys[0]!.emitData("Do you trust this folder?\r\n1. Yes, I trust this folder\r\n");
    await expect.poll(() => frames.join("")).toContain("1. Yes, I trust this folder");
    expect(ptys[0]!.writes).toEqual([]);
    expect(attention).toEqual([]); // held silently: no transient attention without the body
    ptys[0]!.emitData(`\u001b[2J\u001b[H${tty(claudeTrust)}\r\n1. Yes, I trust this folder\r\n`);
    await expect.poll(() => ptys[0]!.writes).toEqual(["1\r"]);
    ptys[0]!.emitData(`\u001b[2J\u001b[H${claudeTty(claudeComposer)}`);
    await queued;
    expect(ptys[0]!.writes).toContain("\u001b[200~held\u001b[201~");
  });
});
