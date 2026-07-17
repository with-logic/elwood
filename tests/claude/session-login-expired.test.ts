/**
 * Conformance for mid-session Claude login expiry (PRD §5.3/§5.7, C-CLAUDE-18):
 * a lapsed-login banner appearing AFTER readiness surfaces a content-free
 * `login_expired` warning + activity exactly once, and leaves the session alive.
 * The startup form of the same banner is fatal and covered elsewhere (C-CLAUDE-17).
 */

import { afterEach, describe, expect, test } from "vitest";
import type { ClaudeHookEventFor } from "../../src/index.ts";
import { startClaude } from "../../src/index.ts";
import { setRecordWriteFaultForTests } from "../../src/state/write-fault.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  setRecordWriteFaultForTests(undefined);
  resetFakes();
});

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

/** The banner renders on the NEXT tick after emit; nudge with a follow-up frame. */
function loginWarnings(session: { warnings: readonly { code: string }[] }): string[] {
  return session.warnings.filter((w) => w.code === "login_expired").map((w) => w.code);
}

describe("ClaudeSession mid-session login expiry (C-CLAUDE-18)", () => {
  test("surfaces a login_expired warning + activity once, and keeps the session alive", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const activities: string[] = [];
    session.on("activity", (event) => activities.push(event.kind));
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    expect(session.status).toBe("ready");

    // The banner is detected on the frame that renders it; a persistent banner
    // across frames warns only ONCE (edge-detected).
    ptys[0]!.emitData(EXPIRED);
    ptys[0]!.emitData(EXPIRED);
    await expect.poll(() => loginWarnings(session).length).toBe(1);
    expect(activities).toContain("warning");
    expect(session.warnings.find((w) => w.code === "login_expired")).toMatchObject({
      code: "login_expired",
      recoveryCommand: "/login",
    });
    // The session is NOT forced terminal — it stays usable for a recovery attempt.
    expect(session.status).toBe("ready");
  });

  test("a login banner BEFORE readiness does not warn (startup handles that fatally)", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    // No readiness hook yet: a banner here is the startup case, not mid-session.
    ptys[0]!.emitData(EXPIRED);
    ptys[0]!.emitData(EXPIRED);
    await Promise.resolve();
    expect(loginWarnings(session)).toHaveLength(0);
  });

  test("the warning de-duplicates: a banner that clears and reappears warns at most once", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));

    ptys[0]!.emitData(EXPIRED);
    await expect.poll(() => loginWarnings(session).length).toBe(1);
    // Clear the banner, let it be observed (re-arming edge detection), then expire
    // again. The edge re-fires, but the identical warning de-duplicates by key, so
    // the session still holds exactly one login_expired warning (no storm).
    ptys[0]!.emitData(NORMAL);
    await expect.poll(() => session.terminal.snapshot().text.includes("back to normal")).toBe(true);
    ptys[0]!.emitData(EXPIRED);
    await expect.poll(() => session.terminal.snapshot().text.includes("/login")).toBe(true);
    expect(loginWarnings(session)).toHaveLength(1);
  });

  test("C-CLAUDE-18 a failed durable write does not lose the warning: a later frame RETRIES", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));

    // Fail the FIRST login_expired persist. The watcher commits only after a durable
    // record, so it stays un-committed and a later frame re-attempts — the warning
    // is not phantom-committed and lost.
    let faults = 0;
    setRecordWriteFaultForTests((record) => {
      if (record.warnings.some((w) => w.code === "login_expired") && faults++ === 0) {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
    });
    ptys[0]!.emitData(EXPIRED); // first attempt: persist throws, warning un-committed
    ptys[0]!.emitData(EXPIRED); // later frame: retry succeeds
    await expect.poll(() => loginWarnings(session).length).toBe(1);
    expect(faults).toBeGreaterThan(0); // the fault path was actually exercised
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
