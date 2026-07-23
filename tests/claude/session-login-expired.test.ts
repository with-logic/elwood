/**
 * Conformance for mid-session Claude login expiry (PRD §5.3/§5.7, C-CLAUDE-18):
 * a lapsed-login banner appearing AFTER readiness surfaces a content-free
 * `login_expired` warning + activity exactly once (live-only, never persisted), and
 * leaves the session alive. The startup form of the same banner is fatal and covered
 * elsewhere (C-CLAUDE-17).
 */

import { afterEach, describe, expect, test } from "vitest";
import type { ClaudeHookEventFor, ClaudeSession } from "../../src/index.ts";
import { startClaude } from "../../src/index.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

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

const EXPIRED = asScreen("Login expired\n Please run /login");
// A normal composer frame (no /login recovery directive) clears the banner state.
const NORMAL = asScreen("❯ \n  back to normal");

/** Collect `login_expired` warning codes off the live `warning` event. */
function collectLoginWarnings(session: ClaudeSession): { code: string }[] {
  const warnings: { code: string }[] = [];
  session.on("warning", (w) => {
    if (w.code === "login_expired") warnings.push(w);
  });
  return warnings;
}

describe("ClaudeSession mid-session login expiry (C-CLAUDE-18)", () => {
  test("surfaces a login_expired warning + activity once, and keeps the session alive", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const activities: string[] = [];
    const warnings = collectLoginWarnings(session);
    session.on("activity", (event) => activities.push(event.kind));
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    expect(session.status).toBe("ready");

    // The banner is detected on the frame that renders it; a persistent banner
    // across frames warns only ONCE (edge-detected).
    ptys[0]!.emitData(EXPIRED);
    ptys[0]!.emitData(EXPIRED);
    await expect.poll(() => warnings.length).toBe(1);
    expect(activities).toContain("warning");
    expect(warnings[0]).toMatchObject({ code: "login_expired", recoveryCommand: "/login" });
    // The session is NOT forced terminal — it stays usable for a recovery attempt.
    expect(session.status).toBe("ready");
  });

  test("a login banner BEFORE readiness does not warn (startup handles that fatally)", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const warnings = collectLoginWarnings(session);
    // No readiness hook yet: a banner here is the startup case, not mid-session.
    ptys[0]!.emitData(EXPIRED);
    ptys[0]!.emitData(EXPIRED);
    await Promise.resolve();
    expect(warnings).toHaveLength(0);
  });

  test("edge-detected: a banner that clears and reappears warns at most once", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const warnings = collectLoginWarnings(session);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));

    ptys[0]!.emitData(EXPIRED);
    await expect.poll(() => warnings.length).toBe(1);
    // Clear the banner, let it be observed (re-arming edge detection), then expire
    // again. The edge fires once more — but a fresh appearance is a distinct live
    // occurrence, so a subsequent identical banner across frames does not storm.
    ptys[0]!.emitData(NORMAL);
    await expect.poll(() => session.terminal.snapshot().text.includes("back to normal")).toBe(true);
    ptys[0]!.emitData(EXPIRED);
    await expect.poll(() => session.terminal.snapshot().text.includes("/login")).toBe(true);
    // A persistent banner never re-fires while raised; the clear/re-raise is a new edge.
    expect(warnings.length).toBeLessThanOrEqual(2);
  });

  test("C-CLAUDE-18 a throwing warning delivery does not lose the edge: a later frame RETRIES", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    // The watcher commits the raised edge only after `recordWarnings` returns without
    // throwing; a warning listener that throws on the FIRST delivery leaves the edge
    // un-committed so a later frame re-attempts — the warning is not lost.
    let throwOnce = true;
    const delivered: string[] = [];
    session.on("warning", (w) => {
      delivered.push(w.code);
      if (throwOnce) {
        throwOnce = false;
        throw new Error("transient listener failure");
      }
    });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    ptys[0]!.emitData(EXPIRED); // first attempt: listener throws, edge un-committed
    ptys[0]!.emitData(EXPIRED); // later frame: retry delivers successfully
    await expect.poll(() => delivered.filter((c) => c === "login_expired").length).toBe(2);
  });

  test("C-CLAUDE-18 a throwing WARNING listener does not suppress the activity nor terminal:data", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const activities: string[] = [];
    let terminalData = 0;
    session.on("warning", () => {
      throw new Error("rogue warning listener");
    });
    session.on("activity", (event) => activities.push(event.kind));
    session.on("terminal:data", () => {
      terminalData += 1;
    });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));

    ptys[0]!.emitData(EXPIRED);
    // The warning listener throws, but the activity fan-out is ISOLATED so the
    // `warning` activity still fires, and the frame's `terminal:data` still delivers.
    await expect.poll(() => activities.includes("warning")).toBe(true);
    expect(terminalData).toBeGreaterThan(0);
  });
});
