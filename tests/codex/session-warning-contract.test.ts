/**
 * Conformance tests for the Codex session live-warning contract on the frame path.
 * Covers PRD §5.7/§9.1 (C-API-14 — warnings are live-only; frame containment is the
 * §5.7 telemetry-isolation property that telemetry must never gate session progress):
 *  - A throwing `warning`/`activity` listener on the hot frame path must NOT wedge the
 *    frame: readiness still reaches ready and `terminal:data` still fires on later frames.
 *  - The preflight/version warning is delivered so a caller subscribing synchronously on
 *    the returned session still observes it (deferred, not replayed to late subscribers).
 *  - No late-replay: a warning emitted before a late subscriber attaches is NOT replayed;
 *    only a subsequent warning reaches it.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { setCommandRunnerForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { codexStartupFrame } from "../helpers/codex-startup-frame.ts";
import { becomeReady, FakePty, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("§5.7 Codex frame-path warning containment (C-API-14 live-only)", () => {
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
    // throw must be contained so the frame still emits terminal:data. Wait on the
    // observable (the banner frame arriving) rather than a fixed sleep.
    const banner = codexStartupFrame(
      "⚠ The linear MCP server is not logged in. Run `codex mcp login linear`.",
    );
    ptys[0]!.emitData(banner);
    await expect.poll(() => data.some((d) => d.includes("linear"))).toBe(true);
    // Readiness still reaches ready via the SessionStart hook despite the throwing listener.
    await becomeReady(session.elwoodSessionId, cwd);
    await session.waitForStatus((status) => status === "ready", 2_000);
    // A later ordinary frame still emits terminal:data (the frame was not wedged).
    ptys[0]!.emitData("ordinary later output");
    await expect.poll(() => data).toContain("ordinary later output");
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

  test("C-CODEX-09 an MCP banner during STARTUP (before resolve) is observed once after return", async () => {
    // An MCP/transcript warning can render during the pre-return startup gate, when
    // the caller has no session to subscribe to. The startup-warning
    // gate BUFFERS it and flushes on a deferred macrotask after return, so an immediate
    // subscriber still sees it exactly once — without late-subscriber replay.
    const cwd = tempDir();
    installFakes();
    // Render the MCP banner DURING startup, from the PTY factory (handler already
    // attached, before startCodex resolves).
    setPtyFactoryForTests((options) => {
      const pty = new FakePty(options);
      ptys.push(pty);
      // Emit the banner as soon as the terminal handler attaches (onData), which is
      // during the pre-return startup gate — so the warning fires before the caller
      // has a session to subscribe to.
      const realOnData = pty.onData.bind(pty);
      pty.onData = (handler) => {
        const off = realOnData(handler);
        queueMicrotask(() =>
          pty.emitData(
            codexStartupFrame(
              "⚠ The linear MCP server is not logged in. Run `codex mcp login linear`.",
            ),
          ),
        );
        return off;
      };
      return pty;
    });
    const session = await startCodex({ cwd });
    const codes: string[] = [];
    session.on("warning", (event) => codes.push(event.code)); // subscribe immediately
    await expect.poll(() => codes).toContain("mcp_server_not_logged_in");
    expect(codes.filter((c) => c === "mcp_server_not_logged_in")).toHaveLength(1); // once
  });
});

describe("C-API-14 Codex warnings are live-only (no late replay)", () => {
  test("a late subscriber gets no prior warning, then only the next one", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    // Emit a first warning and deterministically wait until it has ACTUALLY fired (into
    // an early, soon-detached observer) so the "no replay" check below is proven against
    // a warning that already happened — not merely a sleep that may pre-empt it.
    const early: string[] = [];
    const offEarly = session.on("warning", (event) => early.push(event.code));
    ptys[0]!.emitData(
      codexStartupFrame(
        "⚠ The github MCP server is not logged in. Run `codex mcp login github`.\r\n",
      ),
    );
    await expect.poll(() => early).toContain("mcp_server_not_logged_in");
    offEarly(); // detach: the github banner is now firmly in the PAST
    // Attach LATE: the prior warning must NOT be replayed.
    const seen: { code: string; server?: string }[] = [];
    session.on("warning", (event) => {
      seen.push(
        event.code === "mcp_server_not_logged_in"
          ? { code: event.code, server: event.mcpServerName }
          : { code: event.code },
      );
    });
    expect(seen).toEqual([]); // no replay of the github banner
    // A NEW, different banner (distinct line) reaches the late subscriber (and only it).
    ptys[0]!.emitData(
      codexStartupFrame(
        "⚠ The linear MCP server is not logged in. Run `codex mcp login linear`.\r\n",
      ),
    );
    await expect.poll(() => seen).toEqual([{ code: "mcp_server_not_logged_in", server: "linear" }]);
  });
});
