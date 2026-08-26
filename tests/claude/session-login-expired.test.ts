/**
 * Conformance for mid-session Claude login expiry (PRD §5.3/§5.7, C-CLAUDE-18):
 * a lapsed-login banner appearing AFTER readiness surfaces a content-free
 * `login_expired` warning + activity exactly once (live-only, never persisted), and
 * leaves the session alive. The startup form of the same banner is fatal and covered
 * elsewhere (C-CLAUDE-17).
 */

import { afterEach, describe, expect, test } from "vitest";
import type { ClaudeHookEventFor, ClaudeSessionApi } from "../../src/index.ts";
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
function collectLoginWarnings(session: ClaudeSessionApi): { code: string }[] {
  const warnings: { code: string }[] = [];
  session.on("warning", (w) => {
    if (w.code === "login_expired") warnings.push(w);
  });
  return warnings;
}

describe("ClaudeSessionApi mid-session login expiry (C-CLAUDE-18)", () => {
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

  test("C-CLAUDE-18 detects a mid-session 'Not logged in · Run /login' sign-out banner", async () => {
    // The reported gap: a READY Claude session that gets logged out shows
    // "Not logged in · Run /login" — a different wording than the expiry banners —
    // and previously went undetected mid-session. It is the same recovery, so it
    // must surface the same content-free login_expired warning.
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const warnings = collectLoginWarnings(session);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    expect(session.status).toBe("ready");

    ptys[0]!.emitData(asScreen("⚠ Not logged in · Run /login"));
    await expect.poll(() => warnings.length).toBe(1);
    expect(warnings[0]).toMatchObject({ code: "login_expired", recoveryCommand: "/login" });
    expect(session.status).toBe("ready"); // left alive to recover in place
  });

  test("a login banner BEFORE readiness does not warn (startup handles that fatally)", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const warnings = collectLoginWarnings(session);
    // Both banner frames render through the detached `writeOutput(...).then(...)`
    // chain; count `terminal:data` deliveries so the negative assertion runs only
    // AFTER both frames have actually reached the login observer — not before.
    let frames = 0;
    session.on("terminal:data", () => {
      frames += 1;
    });
    // No readiness hook yet: a banner here is the startup case, not mid-session.
    ptys[0]!.emitData(EXPIRED);
    ptys[0]!.emitData(EXPIRED);
    await expect.poll(() => frames).toBeGreaterThanOrEqual(2);
    // Both frames were observed by the login path, yet no mid-session warning fired.
    expect(warnings).toHaveLength(0);
  });

  test("edge-detected: a cleared-then-reappeared banner fires a SECOND edge, exactly once", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const warnings = collectLoginWarnings(session);
    let frames = 0;
    session.on("terminal:data", () => {
      frames += 1;
    });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));

    ptys[0]!.emitData(EXPIRED);
    await expect.poll(() => warnings.length).toBe(1);
    // Clear the banner, let it be observed (re-arming edge detection), then expire
    // again. The re-appearance is a distinct live occurrence, so the edge MUST fire a
    // second time — poll until it actually arrives rather than merely allowing it.
    ptys[0]!.emitData(NORMAL);
    await expect.poll(() => session.terminal.snapshot().text.includes("back to normal")).toBe(true);
    ptys[0]!.emitData(EXPIRED);
    await expect.poll(() => warnings.length).toBe(2); // the re-raise fired a new edge
    // The now-persistent banner across a FURTHER frame must NOT re-fire. Wait for that
    // frame to actually reach the observer (frame count advances) then assert exactly
    // two (clear→reappear = one new edge; a persistent banner never re-storms).
    const framesBefore = frames;
    ptys[0]!.emitData(EXPIRED);
    await expect.poll(() => frames).toBeGreaterThan(framesBefore);
    expect(warnings.length).toBe(2);
  });

  test("C-CLAUDE-18 a throwing warning listener does NOT duplicate the warning (commit-before-emit)", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    // Warnings are live-only and fire EXACTLY ONCE per occurrence. The edge is committed
    // BEFORE the live fan-out, so a throwing listener is contained and does NOT re-arm the
    // edge — a persistent banner across frames must not re-fire the SAME incident to
    // listeners that already received it. This is the regression for the review's
    // "throwing listener duplicates login_expired" finding.
    const throwing: string[] = [];
    const ok: string[] = [];
    session.on("warning", (w) => {
      throwing.push(w.code);
      throw new Error("listener always throws"); // a persistently-buggy consumer
    });
    session.on("warning", (w) => ok.push(w.code)); // a healthy consumer on the SAME event
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    expect(session.status).toBe("ready");
    ptys[0]!.emitData(EXPIRED);
    ptys[0]!.emitData(EXPIRED); // persistent banner across frames: still ONE occurrence
    await expect.poll(() => ok.filter((c) => c === "login_expired").length).toBe(1);
    // The throwing listener also saw it exactly once — no duplicate re-fire despite the throw.
    expect(throwing.filter((c) => c === "login_expired")).toHaveLength(1);
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
