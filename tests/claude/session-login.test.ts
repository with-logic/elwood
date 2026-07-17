/**
 * Conformance for ClaudeSession.login — the interactive `/login` recovery flow
 * (PRD §5.3, C-API-43). Exercised through the real control queue + fake PTY: it
 * submits /login, drives the method picker, scrapes the auth URL, feeds a pasted
 * code when the CLI asks for one, and resolves only after a FRESH `ready` state
 * follows the success banner. A self-completing flow never asks for a code.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { ARROW_DOWN, ready, succeedAndRecover } from "./login-helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession.login correctness (C-API-43)", () => {
  test("C-API-43 full happy path: picker, URL, code, one Enter, then a fresh ready", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);

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

    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // claudeai is row 0 → NO arrow-down, just the picker Enter.
    ptys[0]!.emitData(asScreen("Select login method:\n Claude account with subscription"));
    await expect.poll(() => ptys[0]!.writes.includes("\r")).toBe(true);
    expect(ptys[0]!.writes).not.toContain(ARROW_DOWN);

    ptys[0]!.emitData(
      asScreen(
        "Authenticate your account at:\nhttps://claude.ai/oauth/authorize?code=x\nPaste code here if prompted > ",
      ),
    );
    await expect.poll(() => codeAsked).toBe(true);
    expect(reportedUrl).toBe("https://claude.ai/oauth/authorize?code=x");
    await expect.poll(() => ptys[0]!.writes.includes("AUTH-CODE-123")).toBe(true);

    await succeedAndRecover(cwd, session);
    await expect(done).resolves.toBeUndefined();

    // Ordered write deltas: /login + its Enter, the picker Enter (no arrow for
    // claudeai), the code, and EXACTLY ONE Enter after the code (not two).
    const writes = ptys[0]!.writes;
    expect(writes[0]).toBe("/login");
    expect(writes[1]).toBe("\r");
    const codeIdx = writes.indexOf("AUTH-CODE-123");
    expect(writes.slice(2, codeIdx)).toEqual(["\r"]); // picker Enter only, no arrow
    expect(writes[codeIdx + 1]).toBe("\r");
    expect(writes.slice(codeIdx + 2)).toEqual([]); // exactly one Enter after the code
  });

  test("C-API-43 non-default method (console = row 1) sends exactly one arrow-down", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);

    const done = session.login({ method: "console", provideCode: () => "x", timeoutMs: 5_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    ptys[0]!.emitData(
      asScreen("Select login method:\n Claude account\n Anthropic Console account"),
    );
    // console is row 1 → exactly one arrow-down before Enter.
    await expect.poll(() => ptys[0]!.writes.filter((w) => w === ARROW_DOWN).length).toBe(1);
    await succeedAndRecover(cwd, session);
    await expect(done).resolves.toBeUndefined();
    expect(ptys[0]!.writes.filter((w) => w === ARROW_DOWN)).toHaveLength(1);
  });

  test("C-API-43 self-completing flow resolves WITHOUT ever asking for a code", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);

    let codeAsked = false;
    // Omit timeoutMs so the default applies — exercises the default branch.
    const done = session.login({
      provideCode: () => {
        codeAsked = true;
        return "unused";
      },
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // No method picker, straight to success (e.g. a browser round-trip completed).
    await succeedAndRecover(cwd, session);
    await expect(done).resolves.toBeUndefined();
    expect(codeAsked).toBe(false);
  });

  test("C-API-43 polls through a neutral intermediate frame before the picker renders", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);

    const done = session.login({ provideCode: () => "x", timeoutMs: 5_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // A neutral frame (neither picker nor a past-picker state): pollUntil must
    // loop (delay + re-read) for a couple of cycles until a recognized screen.
    ptys[0]!.emitData(asScreen("Loading…"));
    await new Promise((r) => setTimeout(r, 250));
    expect(session.status).toBe("ready"); // still alive, driver still polling
    ptys[0]!.emitData(asScreen("Select login method:\n Claude account with subscription"));
    await succeedAndRecover(cwd, session);
    await expect(done).resolves.toBeUndefined();
  });

  test("C-API-43 rejects with login_failed on an invalid-code / failure banner", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);

    const done = session.login({ provideCode: () => "bad", timeoutMs: 5_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    ptys[0]!.emitData(asScreen("Invalid code. Please make sure the full code was copied."));
    await expect(done).rejects.toMatchObject({ code: "login_failed" });
  });

  test("C-API-43 rejects with login_timeout when success never appears", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);

    const done = session.login({ provideCode: () => "x", timeoutMs: 250 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    ptys[0]!.emitData(asScreen("Authenticate your account at:\nhttps://claude.ai/oauth/x"));
    await expect(done).rejects.toMatchObject({ code: "login_timeout" });
  });

  test("C-API-43 rejects with session_not_running when the session is already terminal", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    await session.kill();
    await expect(session.login({ provideCode: () => "x" })).rejects.toMatchObject({
      code: "session_not_running",
    });
  });
});
