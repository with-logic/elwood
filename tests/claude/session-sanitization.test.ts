/**
 * Public-surface conformance for paste sanitization (PRD §5.3, C-API-40): hostile
 * text sent through EVERY text API (`sendPrompt`, `sendMessage`, `sendGuidance`)
 * is neutralized before it is framed as a bracketed paste, so an embedded end
 * sentinel or control byte can never escape paste mode into live keystrokes; the
 * raw `sendKeys` escape hatch is deliberately NOT sanitized. This exercises the
 * real routing through the control queue and PTY, not just `sanitizePasteText`.
 */

import { afterEach, describe, expect, test } from "vitest";
import type { ClaudeHookEventFor } from "../../src/index.ts";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const ESC = String.fromCharCode(27);
// A hostile payload: a bracketed-paste END sentinel followed by a live Enter that,
// unescaped, would end paste mode and confirm a dialog. `NUL` is a bare control byte.
const HOSTILE = `approve?${ESC}[201~${ESC}confirm${String.fromCharCode(0)}`;
// After sanitization the ESC and NUL bytes are stripped, leaving inert text; the
// two framing ESCs around it are the paste mode Elwood itself controls.
const SANITIZED_PASTE = `${ESC}[200~approve?[201~confirm${ESC}[201~`;

afterEach(resetFakes);

const instructionsLoaded = (cwd: string) =>
  ({
    hook_event_name: "InstructionsLoaded",
    session_id: "claude-1",
    cwd,
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  }) satisfies ClaudeHookEventFor<"InstructionsLoaded">;

const stopHook = (cwd: string) =>
  ({
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
    stop_hook_active: false,
  }) satisfies ClaudeHookEventFor<"Stop">;

async function readySession(cwd: string) {
  installFakes();
  const session = await startClaude({ cwd });
  await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
  return session;
}

describe("ClaudeSession paste sanitization through public APIs (C-API-40)", () => {
  test("C-API-40 sendPrompt strips the embedded sentinel and control bytes before framing", async () => {
    const cwd = tempDir();
    const session = await readySession(cwd);
    await session.sendPrompt(HOSTILE);
    // The ONLY ESC bytes in the framed write are the paste-mode sentinels Elwood
    // added; the payload's own ESC and NUL are gone, so it cannot break out.
    expect(ptys[0]!.writes[0]).toBe(SANITIZED_PASTE);
    expect(ptys[0]!.writes[0]).not.toContain(`${ESC}confirm`);
  });

  test("C-API-40 sendMessage sanitizes hostile text on the same paste path", async () => {
    const cwd = tempDir();
    const session = await readySession(cwd);
    await session.sendMessage(HOSTILE);
    expect(ptys[0]!.writes[0]).toBe(SANITIZED_PASTE);
  });

  test("C-API-40 sendGuidance sanitizes hostile text on the same paste path", async () => {
    const cwd = tempDir();
    const session = await readySession(cwd);
    // Guidance queued at readiness pastes immediately; the payload is sanitized too.
    await session.sendGuidance(HOSTILE);
    expect(ptys[0]!.writes[0]).toBe(SANITIZED_PASTE);
    // Prove a turn can still be ended after (no wedged state from the hostile input).
    await ptys[0]!.dispatchHook(session.elwoodSessionId, stopHook(cwd));
  });

  test("C-API-40 sendKeys is the raw escape hatch and is NOT sanitized", async () => {
    const cwd = tempDir();
    const session = await readySession(cwd);
    // `sendKeys` writes the exact bytes verbatim — control bytes and all — because
    // it is the intentional raw hatch. The hostile string reaches the PTY unchanged.
    await session.sendKeys(HOSTILE);
    expect(ptys[0]!.writes[0]).toBe(HOSTILE);
    expect(ptys[0]!.writes[0]).toContain(`${ESC}[201~`);
  });
});
