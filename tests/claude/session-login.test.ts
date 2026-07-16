/**
 * Conformance for ClaudeSession.login — the interactive `/login` recovery flow
 * (PRD §5.3, C-API-43). Exercised through the real control queue + fake PTY: it
 * submits /login, drives the method picker, scrapes the auth URL, feeds a pasted
 * code when the CLI asks for one, and resolves on success / rejects on
 * failure/timeout. A self-completing flow never asks for a code.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const ESC = String.fromCharCode(27);
const ARROW_DOWN = `${ESC}[B`;

const instructionsLoaded = (cwd: string) => ({
  hook_event_name: "InstructionsLoaded",
  session_id: "claude-1",
  cwd,
  file_path: "/tmp/CLAUDE.md",
  memory_type: "Project",
  load_reason: "session_start",
});

async function ready(cwd: string, id: string) {
  await ptys[0]!.dispatchHook(id, instructionsLoaded(cwd));
}

describe("ClaudeSession.login (C-API-43)", () => {
  test("drives the method picker, reports the URL, feeds the code, and resolves on success", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session.elwoodSessionId);

    let reportedUrl: string | undefined;
    let codeAsked = false;
    const done = session.login({
      onAuthUrl: (url) => {
        reportedUrl = url;
      },
      provideCode: () => {
        codeAsked = true;
        return "AUTH-CODE-123";
      },
      timeoutMs: 5_000,
    });

    // /login is submitted as a command.
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // Method picker renders; claudeai is row 0, so NO arrow-down, just Enter.
    ptys[0]!.emitData(asScreen("Select login method:\n Claude account with subscription"));
    await expect.poll(() => ptys[0]!.writes.includes("\r")).toBe(true);
    expect(ptys[0]!.writes).not.toContain(ARROW_DOWN);

    // The authorize URL + paste prompt render together.
    ptys[0]!.emitData(
      asScreen(
        "Authenticate your account at:\nhttps://claude.ai/oauth/authorize?code=x\nPaste code here if prompted > ",
      ),
    );
    await expect.poll(() => codeAsked).toBe(true);
    expect(reportedUrl).toBe("https://claude.ai/oauth/authorize?code=x");
    // The pasted code and its Enter reach the PTY.
    await expect.poll(() => ptys[0]!.writes.includes("AUTH-CODE-123")).toBe(true);

    // The CLI reports success and the flow resolves.
    ptys[0]!.emitData(asScreen("Login successful."));
    await expect(done).resolves.toBeUndefined();
  });

  test("a self-completing flow resolves on success WITHOUT ever asking for a code", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session.elwoodSessionId);

    let codeAsked = false;
    // Omit timeoutMs so the default (300s) applies — exercises the default branch.
    const done = session.login({
      provideCode: () => {
        codeAsked = true;
        return "unused";
      },
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // No method picker, straight to success (e.g. a browser round-trip completed).
    ptys[0]!.emitData(asScreen("Login successful. Logged in as user@example.com"));
    await expect(done).resolves.toBeUndefined();
    expect(codeAsked).toBe(false);
  });

  test("polls through a neutral intermediate frame before the picker renders", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session.elwoodSessionId);

    const done = session.login({ provideCode: () => "x", timeoutMs: 5_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // A neutral frame (neither picker nor a past-picker state) is on screen while
    // the driver polls: settleUntil must loop (delay + re-read) until a recognized
    // screen appears. Hold it neutral for a couple of poll cycles first.
    ptys[0]!.emitData(asScreen("Loading…"));
    await new Promise((r) => setTimeout(r, 250));
    expect(session.status).toBe("ready"); // still alive, driver still polling
    // Then the picker renders and the flow proceeds to success.
    ptys[0]!.emitData(asScreen("Select login method:\n Claude account with subscription"));
    ptys[0]!.emitData(asScreen("Login successful."));
    await expect(done).resolves.toBeUndefined();
  });

  test("selects a non-default method by arrowing down to its row", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session.elwoodSessionId);

    const done = session.login({
      method: "console",
      provideCode: () => "x",
      timeoutMs: 5_000,
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    ptys[0]!.emitData(
      asScreen("Select login method:\n Claude account\n Anthropic Console account"),
    );
    // console is row 1 → exactly one arrow-down before Enter.
    await expect.poll(() => ptys[0]!.writes.filter((w) => w === ARROW_DOWN).length).toBe(1);
    ptys[0]!.emitData(asScreen("Login successful."));
    await expect(done).resolves.toBeUndefined();
  });

  test("rejects with login_failed on an invalid-code / failure banner", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session.elwoodSessionId);

    const done = session.login({ provideCode: () => "bad", timeoutMs: 5_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    ptys[0]!.emitData(asScreen("Invalid code. Please make sure the full code was copied."));
    await expect(done).rejects.toMatchObject({ code: "login_failed" });
  });

  test("rejects with login_timeout when success never appears", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session.elwoodSessionId);

    const done = session.login({ provideCode: () => "x", timeoutMs: 250 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // The picker never advances to success within the timeout.
    ptys[0]!.emitData(asScreen("Authenticate your account at:\nhttps://claude.ai/oauth/x"));
    await expect(done).rejects.toMatchObject({ code: "login_timeout" });
  });

  test("rejects with session_not_running when the session is already terminal", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session.elwoodSessionId);
    await session.kill();
    await expect(session.login({ provideCode: () => "x" })).rejects.toMatchObject({
      code: "session_not_running",
    });
  });
});
