/**
 * Codex session-level trust-prompt behavior.
 * Covers PRD §5.5 (C-CODEX-06, C-CODEX-11, C-CODEX-15) and C-ATTN-03.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexComposer, codexHooks, codexTrust, toCrlf } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSessionApi trust prompts", () => {
  test("C-CODEX-06 C-CODEX-15 trusts hooks via the TUI prompt and does NOT block", async () => {
    // autotrust OFF, but hook trust (Elwood's own integration) is still answered
    // — automatic handling gets its bounded window before human fallback (C-ATTN-03).
    installFakes({ supportsHookTrustBypass: false });
    const session = await startCodex({ cwd: tempDir() });
    const attention: string[] = [];
    session.on("activity", (e) => e.kind === "attention" && attention.push(e.label));
    ptys[0]!.emitData(`${toCrlf(codexHooks)}\r\n  1. Review hooks\r\n› 2. Trust all and continue`);
    await expect.poll(() => ptys[0]!.writes).toEqual(["2\r"]);
    expect(attention).toEqual([]);
    expect(session.status).not.toBe("blocked");
  });

  test("C-TRUST-01 a human gate handing off to automatic hook trust still reaches ready", async () => {
    const native = (name: string) =>
      readFileSync(new URL(`../fixtures/codex-0.154.0/${name}.txt`, import.meta.url), "utf8");
    const repaint = (frame: string) =>
      ptys[0]!.emitData(`\u001b[2J\u001b[H${frame.replaceAll("\n", "\r\n")}`);
    installFakes({ supportsHookTrustBypass: false });
    const session = await startCodex({ cwd: tempDir() });
    const queued = session.sendMessage("hello");
    repaint(native("directory"));
    await expect.poll(() => session.status).toBe("blocked");
    // The human answers; the automation-owned hooks gate replaces it in one repaint,
    // so the only blocked-to-ready edge arrives while automation holds input.
    repaint(native("hooks"));
    await expect.poll(() => ptys[0]!.writes).toEqual(["2\r"]);
    repaint(codexComposer);
    await queued;
    expect(ptys[0]!.writes).toContain("\u001b[200~hello\u001b[201~");
  });

  test("C-CODEX-11 autotrust answers Codex directory prompts", async () => {
    installFakes();
    const session = await startCodex({ cwd: tempDir(), autotrust: true });
    const activity: string[] = [];
    session.on("activity", (event) => activity.push(`${event.kind}:${event.label}`));
    ptys[0]!.emitData(`${toCrlf(codexTrust)}\r\n› 1. Yes, continue`);
    await expect.poll(() => ptys[0]!.writes).toEqual(["1\r"]);
    expect(activity).not.toContain("startup_prompt:workspace_trust");
    ptys[0]!.emitData(`\u001b[2J\u001b[H${codexComposer.replaceAll("\n", "\r\n")}`);
    await expect.poll(() => activity).toContain("startup_prompt:workspace_trust");
  });

  test("C-CODEX-17 a rejected trust-prompt write stays retryable and warns", async () => {
    installFakes();
    const session = await startCodex({ cwd: tempDir(), autotrust: true });
    const warnings: string[] = [];
    session.on("warning", (event) => warnings.push(event.code));
    // The PTY rejects the trust answer write: the prompt stays retryable and
    // surfaces the bounded warning rather than being reported as answered.
    ptys[0]!.failOnWrite = "1\r";
    ptys[0]!.emitData(`${toCrlf(codexTrust)}\r\n› 1. Yes, continue`);
    await expect.poll(() => warnings).toContain("startup_prompt_write_failed");
    // Retryable: a later frame re-attempts the answer with a now-succeeding write.
    ptys[0]!.failOnWrite = undefined;
    ptys[0]!.emitData(`\u001b[2J\u001b[H${toCrlf(codexTrust)}\r\n› 1. Yes, continue`);
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
    ptys[0]!.emitData(`${toCrlf(codexTrust)}\r\n› 1. No, quit`);
    await expect.poll(() => attention).toContain("workspace_trust");
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
    ptys[0]!.emitData(`${toCrlf(codexTrust)}\r\n› 1. No, quit`);
    // The frame was not aborted by the throw: terminal:data still fires for it.
    await expect.poll(() => terminalData).toBeGreaterThan(0);
  });

  test("C-CODEX-15 a partial frame followed by a complete frame ANSWERS the prompt, no stale warning", async () => {
    installFakes();
    const session = await startCodex({ cwd: tempDir(), autotrust: true });
    const warnings: string[] = [];
    const attention: string[] = [];
    session.on("warning", (event) => warnings.push(event.code));
    session.on("activity", (e) => e.kind === "attention" && attention.push(e.label));
    // Frame 1: header and body only — transient pending (observable as the attention), nothing sent.
    ptys[0]!.emitData(toCrlf(codexTrust));
    await expect.poll(() => attention).toContain("workspace_trust");
    expect(ptys[0]!.writes).toEqual([]);
    // Frame 2 redraws the same dialog with its affirmative.
    ptys[0]!.emitData(`\u001b[2J\u001b[H${toCrlf(codexTrust)}\r\n› 1. Yes, continue`);
    await expect.poll(() => ptys[0]!.writes).toEqual(["1\r"]);
    expect(warnings).not.toContain("trust_prompt_unanswerable");
  });

  test("C-TRUST-01 a header without its native body holds input untyped until the body paints", async () => {
    installFakes();
    const session = await startCodex({ cwd: tempDir(), autotrust: true });
    const frames: string[] = [];
    session.on("terminal:data", (event) => frames.push(event.data));
    const attention: string[] = [];
    session.on("activity", (e) => e.kind === "attention" && attention.push(e.label));
    const queued = session.sendMessage("held");
    ptys[0]!.emitData("Do you trust the contents of this directory?\r\n› 1. Yes, continue");
    await expect.poll(() => frames.join("")).toContain("1. Yes, continue");
    expect(ptys[0]!.writes).toEqual([]);
    expect(attention).toEqual([]); // held silently: no transient attention without the body
    ptys[0]!.emitData(`\u001b[2J\u001b[H${toCrlf(codexTrust)}\r\n› 1. Yes, continue`);
    await expect.poll(() => ptys[0]!.writes).toEqual(["1\r"]);
    ptys[0]!.emitData(`\u001b[2J\u001b[H${toCrlf(codexComposer)}`);
    await queued;
    expect(ptys[0]!.writes).toContain("\u001b[200~held\u001b[201~");
  });
});
