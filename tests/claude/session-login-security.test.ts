/**
 * Adversarial conformance for ClaudeSession.login (PRD §5.3, C-API-43 security).
 * The scraped browser URL and the human authorization code are UNTRUSTED: a code
 * that could inject terminal control bytes is never written and fails the flow; a
 * spoofed / off-host / plain-http URL is never reported to the caller; and stale
 * pre-login text (a leftover prompt or success banner) can never drive the flow.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { driveFreshReady, ready } from "./login-helpers.ts";

afterEach(resetFakes);

const PASTE_SCREEN = asScreen("Paste code here if prompted > ");

// Each hostile code either injects a terminal control byte, is oversized, or empty.
const hostileCodes: readonly [label: string, code: string][] = [
  ["embedded carriage return", "GOOD\rENTER"],
  ["embedded ESC (would arm a keypress)", `GOOD${String.fromCharCode(27)}[B`],
  ["embedded NUL", `GOOD${String.fromCharCode(0)}NUL`],
  ["oversized (> 512 chars)", "X".repeat(513)],
  ["empty", ""],
];

describe("ClaudeSession.login security (C-API-43)", () => {
  test.each(
    hostileCodes,
  )("C-API-43 rejects a hostile code (%s) and never writes it to the PTY", async (_label, hostile) => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    const done = session.login({ provideCode: () => hostile, timeoutMs: 5_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    ptys[0]!.emitData(PASTE_SCREEN);
    await expect(done).rejects.toMatchObject({ code: "login_failed" });
    // The hostile code (and any control-bearing prefix of it) never reached the PTY.
    expect(ptys[0]!.writes).not.toContain(hostile);
  });

  test("C-API-43 does NOT report a spoofed / off-host / plain-http auth URL to onAuthUrl", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    const reported: string[] = [];
    const done = session.login({
      onAuthUrl: (url) => reported.push(url),
      provideCode: () => "code",
      timeoutMs: 5_000,
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // A look-alike host and a plain-http claude.ai URL are both untrusted.
    ptys[0]!.emitData(
      asScreen(
        "Authenticate your account at:\nhttps://evilclaude.com/oauth/x\nhttp://claude.ai/oauth/x\nPaste code here > ",
      ),
    );
    await expect.poll(() => ptys[0]!.writes.includes("code")).toBe(true);
    // Neither spoofed URL was ever handed to the caller.
    expect(reported).toHaveLength(0);
    ptys[0]!.emitData(asScreen("Login successful."));
    await driveFreshReady(cwd, session);
    await expect(done).resolves.toBeUndefined();
  });

  test("C-API-43 reports a valid https claude.ai OAuth URL", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    const reported: string[] = [];
    const done = session.login({
      onAuthUrl: (url) => reported.push(url),
      provideCode: () => "code",
      timeoutMs: 5_000,
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    ptys[0]!.emitData(
      asScreen(
        "Authenticate your account at:\nhttps://claude.ai/oauth/authorize?a=1\nPaste code > ",
      ),
    );
    await expect.poll(() => reported.length).toBe(1);
    expect(reported[0]).toBe("https://claude.ai/oauth/authorize?a=1");
    ptys[0]!.emitData(asScreen("Login successful."));
    await driveFreshReady(cwd, session);
    await expect(done).resolves.toBeUndefined();
  });

  test("C-API-43 does not invoke onAuthUrl when the URL screen carries no extractable URL", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    const reported: string[] = [];
    const done = session.login({
      onAuthUrl: (url) => reported.push(url),
      provideCode: () => "code",
      timeoutMs: 5_000,
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // The URL phrase renders but no OAuth URL is on screen (extractAuthUrl → none):
    // onAuthUrl must not fire on an empty scrape.
    ptys[0]!.emitData(asScreen("Opening browser to authorize…\nPaste code here > "));
    await expect.poll(() => ptys[0]!.writes.includes("code")).toBe(true);
    expect(reported).toHaveLength(0);
    ptys[0]!.emitData(asScreen("Login successful."));
    await driveFreshReady(cwd, session);
    await expect(done).resolves.toBeUndefined();
  });

  test("C-API-43 a stale pre-login success banner does not resolve the flow", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    // Baseline: a leftover "Login successful." banner is ALREADY on screen before
    // login() is called. It is stale and must not settle THIS attempt.
    ptys[0]!.emitData(asScreen("Login successful. (from a previous session)"));
    await expect
      .poll(() => session.terminal.snapshot().text.includes("Login successful"))
      .toBe(true);

    const done = session.login({ provideCode: () => "x", timeoutMs: 300 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // The banner already on the baseline can never resolve login: the driver waits
    // for a FRESH success and instead hits the deadline.
    await expect(done).rejects.toMatchObject({ code: "login_timeout" });
  });

  test("C-API-43 a stale pre-login paste prompt never discloses the code", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    // Baseline: a leftover "Paste code here" prompt sits on screen before login().
    ptys[0]!.emitData(asScreen("Paste code here > (leftover from a prior attempt)"));
    await expect
      .poll(() => session.terminal.snapshot().text.includes("Paste code here"))
      .toBe(true);

    let codeAsked = false;
    const done = session.login({
      provideCode: () => {
        codeAsked = true;
        return "SECRET-CODE";
      },
      timeoutMs: 300,
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // The stale prompt never triggers disclosure; the flow times out instead.
    await expect(done).rejects.toMatchObject({ code: "login_timeout" });
    expect(codeAsked).toBe(false);
    expect(ptys[0]!.writes).not.toContain("SECRET-CODE");
  });
});
