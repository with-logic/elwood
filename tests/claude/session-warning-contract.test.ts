/**
 * Conformance tests for the Claude session live-warning contract on the frame path.
 * Covers PRD §5.7/§9.1 (C-API-14, C-API-37):
 *  - A throwing `warning` listener on the hot frame path must NOT wedge the frame:
 *    readiness still reaches ready and `terminal:data` still fires on later frames.
 *  - The preflight/version warning is delivered so a caller subscribing synchronously
 *    on the returned session still observes it (deferred, not late-replayed).
 *  - No late-replay: a warning emitted before a late subscriber attaches is NOT replayed.
 */

import { afterEach, describe, expect, test } from "vitest";
import type { ClaudeHookEventFor } from "../../src/index.ts";
import { startClaude } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

const instructionsLoaded = (cwd: string): ClaudeHookEventFor<"InstructionsLoaded"> => ({
  hook_event_name: "InstructionsLoaded",
  session_id: "claude-1",
  cwd,
  file_path: `${cwd}/CLAUDE.md`,
  memory_type: "Project",
  load_reason: "session_start",
});
const EXPIRED = asScreen("Login expired\n Please run /login");

describe("C-API-37 Claude frame-path warning containment", () => {
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
    // listener around now — the throw must be contained so frames keep flowing.
    ptys[0]!.emitData("startup frame");
    await flush();
    // Readiness still transitions to ready (via the Stop-hook turn boundary) despite the
    // throwing warning listener — telemetry never gates session progress (C-API-37).
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    await flush();
    // A later ordinary frame still emits terminal:data (the frame path was not wedged).
    ptys[0]!.emitData("ordinary later output");
    await flush();
    expect(data).toContain("startup frame");
    expect(data).toContain("ordinary later output"); // frames kept flowing after the throw
    expect(statuses).toContain("ready"); // readiness still advanced
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
});

describe("C-API-14 Claude warnings are live-only (no late replay)", () => {
  test("a late subscriber gets no prior warning, then ONLY the next live one", async () => {
    const cwd = tempDir();
    installFakes();
    setCommandRunnerForTests(() => ({ status: 0, stdout: "unknown build", stderr: "" }));
    // Start WITHOUT a warning subscriber; the preflight warning fires into no listener.
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd)); // reach ready
    ptys[0]!.emitData("first frame"); // drive the frame; preflight macrotask fires unheard
    await flush();
    // Attach LATE: the prior preflight warning must NOT be replayed to this subscriber.
    const codes: string[] = [];
    session.on("warning", (event) => codes.push(event.code));
    await flush();
    expect(codes).toEqual([]); // no replay of the version_unparseable warning
    // POSITIVE CONTROL: a NEW live warning after subscription MUST still arrive — proving
    // the empty result above is "no replay", not "delivery is broken".
    ptys[0]!.emitData(EXPIRED); // a login-expiry banner emits a fresh live warning
    await expect.poll(() => codes).toContain("login_expired");
    expect(codes).not.toContain("version_unparseable"); // still never the replayed one
  });
});
