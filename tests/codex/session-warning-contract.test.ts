/**
 * Conformance tests for the Codex session live-warning contract on the frame path.
 * Covers PRD §5.7/§9.1 (C-API-14, C-API-37):
 *  - A throwing `warning`/`activity` listener on the hot frame path must NOT wedge the
 *    frame: readiness still reaches ready and `terminal:data` still fires on later frames.
 *  - The preflight/version warning is delivered so a caller subscribing synchronously on
 *    the returned session still observes it (deferred, not replayed to late subscribers).
 *  - No late-replay: a warning emitted before a late subscriber attaches is NOT replayed;
 *    only a subsequent warning reaches it.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("C-API-37 Codex frame-path warning containment", () => {
  test("a throwing warning listener does not prevent readiness or terminal:data", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    // A caller `warning` listener that ALWAYS throws — a programming bug in a parent app.
    session.on("warning", () => {
      throw new Error("listener bug on warning");
    });
    const data: string[] = [];
    session.on("terminal:data", (event) => data.push(event.data));
    // A frame that emits a warning (MCP banner) through the throwing listener: the
    // throw must be contained so the frame still emits terminal:data.
    ptys[0]!.emitData("The linear MCP server is not logged in. Run `codex mcp login linear`.");
    await flush();
    // Readiness still reaches ready via the SessionStart hook despite the throwing listener.
    await becomeReady(session.elwoodSessionId, cwd);
    await session.waitForStatus((status) => status === "ready", 2_000);
    // A later ordinary frame still emits terminal:data (the frame was not wedged).
    ptys[0]!.emitData("ordinary later output");
    await flush();
    expect(data).toContain("ordinary later output");
    expect(session.status).toBe("ready");
  });
});

describe("C-API-14 Codex preflight warning is observable on the returned session", () => {
  test("a caller subscribing synchronously after start sees the preflight warning", async () => {
    const cwd = tempDir();
    installFakes();
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("--help")
        ? { status: 0, stdout: "--dangerously-bypass-hook-trust", stderr: "" }
        : { status: 0, stdout: "unknown build", stderr: "" },
    );
    const session = await startCodex({ cwd });
    // Subscribe synchronously in the SAME turn the session is returned — the preflight
    // warning is deferred to a macrotask AFTER start resolves, so it is still observed.
    const codes: string[] = [];
    session.on("warning", (event) => codes.push(event.code));
    await expect.poll(() => codes).toContain("version_unparseable");
  });
});

describe("C-API-14 Codex warnings are live-only (no late replay)", () => {
  test("a late subscriber gets no prior warning, then only the next one", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    // Emit a first warning with NO subscriber attached (its own line so it parses).
    ptys[0]!.emitData("The github MCP server is not logged in. Run `codex mcp login github`.\r\n");
    await flush();
    // Attach LATE: the prior warning must NOT be replayed.
    const seen: { code: string; server?: string }[] = [];
    session.on("warning", (event) => {
      seen.push(
        event.code === "mcp_server_not_logged_in"
          ? { code: event.code, server: event.mcpServerName }
          : { code: event.code },
      );
    });
    await flush();
    expect(seen).toEqual([]); // no replay of the github banner
    // A NEW, different banner (distinct line) reaches the late subscriber (and only it).
    ptys[0]!.emitData("The linear MCP server is not logged in. Run `codex mcp login linear`.\r\n");
    await flush();
    expect(seen).toEqual([{ code: "mcp_server_not_logged_in", server: "linear" }]);
  });
});
