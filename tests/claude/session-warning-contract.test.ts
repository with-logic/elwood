/**
 * Conformance tests for the Claude session live-warning contract on the frame path.
 * Covers PRD §5.7/§9.1 (C-API-14 — warnings are live-only; frame containment is the
 * §5.7 telemetry-isolation property that telemetry must never gate session progress):
 *  - A throwing `warning` listener on the hot frame path must NOT wedge the frame:
 *    readiness still reaches ready and `terminal:data` still fires on later frames.
 *  - The preflight/version warning is delivered so a caller subscribing synchronously
 *    on the returned session still observes it (deferred, not late-replayed).
 *  - No late-replay: a warning emitted before a late subscriber attaches is NOT replayed.
 */

import { afterEach, describe, expect, test } from "vitest";
import type { ClaudeHookEventFor } from "../../src/index.ts";
import { startClaude } from "../../src/index.ts";
import { setCommandRunnerForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { FakePty, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const instructionsLoaded = (cwd: string): ClaudeHookEventFor<"InstructionsLoaded"> => ({
  hook_event_name: "InstructionsLoaded",
  session_id: "claude-1",
  cwd,
  file_path: `${cwd}/CLAUDE.md`,
  memory_type: "Project",
  load_reason: "session_start",
});
const EXPIRED = asScreen("Login expired\n Please run /login");

describe("§5.7 Claude frame-path warning containment (C-API-14 live-only)", () => {
  test("a throwing warning listener does not prevent readiness or terminal:data", async () => {
    const cwd = tempDir();
    installFakes();
    // A preflight/version warning will be delivered (macrotask) into the throwing
    // listener below; its containment must not wedge the frame path.
    setCommandRunnerForTests(() => ({ status: 0, stdout: "unknown build", stderr: "" }));
    const session = await startClaude({ cwd });
    // A caller `warning` listener that ALWAYS throws — a parent app programming bug.
    // It fires when the deferred preflight warning is delivered.
    session.on("warning", () => {
      throw new Error("listener bug on warning");
    });
    const data: string[] = [];
    const statuses: string[] = [];
    session.on("terminal:data", (event) => data.push(event.data));
    session.on("status", (event) => statuses.push(event.status));
    // Drive a startup frame; the deferred preflight warning fires into the throwing
    // listener around now — the throw must be contained so frames keep flowing. Wait
    // on the observable (the frame arriving) rather than a fixed sleep.
    ptys[0]!.emitData("startup frame");
    await expect.poll(() => data).toContain("startup frame");
    // Readiness still transitions to ready (via the Stop-hook turn boundary) despite the
    // throwing warning listener — telemetry never gates session progress (§5.7).
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    await expect.poll(() => statuses).toContain("ready"); // readiness still advanced
    // A later ordinary frame still emits terminal:data (the frame path was not wedged).
    ptys[0]!.emitData("ordinary later output");
    await expect.poll(() => data).toContain("ordinary later output"); // frames kept flowing
  });
});

describe("C-API-14 Claude preflight warning is observable on the returned session", () => {
  test("a caller subscribing synchronously after start sees the preflight warning", async () => {
    const cwd = tempDir();
    installFakes();
    setCommandRunnerForTests(() => ({ status: 0, stdout: "unknown build", stderr: "" }));
    const session = await startClaude({ cwd });
    // Subscribe synchronously in the SAME turn the session is returned — the preflight
    // warning is deferred to a macrotask AFTER start resolves, so it is still observed.
    const codes: string[] = [];
    session.on("warning", (event) => codes.push(event.code));
    await expect.poll(() => codes).toContain("version_unparseable");
  });

  test("survives ordinary PTY output BEFORE the start promise resolves (the original race)", async () => {
    // Real CLI output streams DURING startup,
    // before the caller has a session to subscribe to. If the preflight fired on a
    // startup frame it would be consumed unheard. Because it is deferred to AFTER
    // start resolves, pre-return terminal chatter cannot consume it.
    const cwd = tempDir();
    installFakes();
    setCommandRunnerForTests(() => ({ status: 0, stdout: "unknown build", stderr: "" }));
    // Emit ordinary startup output on a microtask from the PTY factory, so it fires
    // during startup (handler attached) BEFORE `startClaude` resolves.
    setPtyFactoryForTests((options) => {
      const pty = new FakePty(options);
      ptys.push(pty);
      queueMicrotask(() => pty.emitData("streaming startup output\n"));
      return pty;
    });
    const session = await startClaude({ cwd });
    // Only now can the caller subscribe — the preflight must still arrive.
    const codes: string[] = [];
    session.on("warning", (event) => codes.push(event.code));
    await expect.poll(() => codes).toContain("version_unparseable");
  });
});

describe("C-API-14 Claude warnings are live-only (no late replay)", () => {
  test("a late subscriber gets no prior warning, then ONLY the next live one", async () => {
    const cwd = tempDir();
    installFakes();
    setCommandRunnerForTests(() => ({ status: 0, stdout: "unknown build", stderr: "" }));
    const session = await startClaude({ cwd });
    // Attach an early, soon-detached observer SYNCHRONOUSLY (before the deferred
    // preflight macrotask fires) and wait until the preflight warning has ACTUALLY
    // fired into it, so "no replay" below is proven against a warning that already
    // happened — not merely a sleep that may pre-empt it.
    const early: string[] = [];
    const offEarly = session.on("warning", (event) => early.push(event.code));
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd)); // reach ready
    ptys[0]!.emitData("first frame"); // drive the frame; preflight macrotask fires
    await expect.poll(() => early).toContain("version_unparseable");
    offEarly(); // detach: the preflight is now firmly in the PAST
    // Attach LATE: the prior preflight warning must NOT be replayed to this subscriber.
    const codes: string[] = [];
    session.on("warning", (event) => codes.push(event.code));
    expect(codes).toEqual([]); // no replay of the version_unparseable warning
    // POSITIVE CONTROL: a NEW live warning after subscription MUST still arrive — proving
    // the empty result above is "no replay", not "delivery is broken".
    ptys[0]!.emitData(EXPIRED); // a login-expiry banner emits a fresh live warning
    await expect.poll(() => codes).toContain("login_expired");
    expect(codes).not.toContain("version_unparseable"); // still never the replayed one
  });
});
