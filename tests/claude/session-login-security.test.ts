/**
 * Adversarial conformance for ClaudeSessionApi.login (PRD §5.3, C-API-43 security).
 * The scraped browser URL and the human authorization code are UNTRUSTED: a code
 * that could inject terminal control bytes is never written and fails the flow; a
 * spoofed / off-host / plain-http URL is never reported to the caller; and stale
 * pre-login text (a leftover prompt or success banner) can never drive the flow.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { ready, succeedAndRecover } from "./login-helpers.ts";

afterEach(resetFakes);

// The real code prompt follows the authorizing (browser URL) stage — the driver
// only honors a code prompt once it has entered that stage (ordered stages).
const PASTE_SCREEN = asScreen(
  "Authenticate your account at:\nhttps://claude.ai/oauth/x\nPaste code here if prompted > ",
);

// Each hostile code either injects a terminal control byte, is oversized, or empty.
const hostileCodes: readonly [label: string, code: string][] = [
  ["embedded carriage return", "GOOD\rENTER"],
  ["embedded ESC (would arm a keypress)", `GOOD${String.fromCharCode(27)}[B`],
  ["embedded NUL", `GOOD${String.fromCharCode(0)}NUL`],
  ["oversized (> 512 chars)", "X".repeat(513)],
  ["empty", ""],
];

describe("ClaudeSessionApi.login security (C-API-43)", () => {
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

  test("C-API-43 the code is NOT written if the paste prompt vanishes while provideCode is pending", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    // `provideCode` is slow (human fetching the code); WHILE it is pending, the
    // paste prompt disappears (a normal composer replaces it). The code must NOT be
    // written into that different screen — the flow fails instead of disclosing it.
    const done = session.login({
      provideCode: async () => {
        ptys[0]!.emitData(asScreen("❯ back to the normal composer"));
        await new Promise((r) => setTimeout(r, 120));
        return "SECRET-CODE";
      },
      timeoutMs: 5_000,
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    ptys[0]!.emitData(PASTE_SCREEN);
    await expect(done).rejects.toMatchObject({ code: "login_failed" });
    expect(ptys[0]!.writes).not.toContain("SECRET-CODE");
  });

  test("C-API-43 a spoofed / off-host / plain-http auth URL is never reported NOR advances to code disclosure", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    const reported: string[] = [];
    let codeAsked = false;
    const done = session.login({
      onAuthUrl: (url) => reported.push(url),
      provideCode: () => {
        codeAsked = true;
        return "code";
      },
      timeoutMs: 400,
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // A look-alike host and a plain-http claude.ai URL are both untrusted, so no
    // VALID auth URL ever appears: the URL is not reported AND the authorizing
    // stage is never entered, so the code prompt never discloses the code — the
    // flow times out rather than trusting spoofed authorization context.
    ptys[0]!.emitData(
      asScreen(
        "Authenticate your account at:\nhttps://evilclaude.com/oauth/x\nhttp://claude.ai/oauth/x\nPaste code here > ",
      ),
    );
    await expect(done).rejects.toMatchObject({ code: "login_timeout" });
    expect(reported).toHaveLength(0);
    expect(codeAsked).toBe(false);
  });

  // A throwing onAuthUrl (Error OR bare non-Error) surfaces a bounded login_failed,
  // never escapes raw — exercising both `cause` shapes.
  const urlThrowers: readonly [label: string, make: () => unknown][] = [
    ["an Error", () => new Error("browser open failed")],
    ["a non-Error value", () => "browser string fault"],
  ];
  test.each(
    urlThrowers,
  )("C-API-43 a throwing onAuthUrl callback (%s) rejects login with login_failed", async (_label, make) => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    const done = session.login({
      onAuthUrl: () => {
        throw make();
      },
      provideCode: () => "code",
      timeoutMs: 5_000,
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    ptys[0]!.emitData(asScreen("Authenticate your account at:\nhttps://claude.ai/oauth/x"));
    await expect(done).rejects.toMatchObject({ code: "login_failed" });
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
    await succeedAndRecover(cwd, session);
    await expect(done).resolves.toBeUndefined();
  });

  test("C-API-43 a phrase-only screen does not report a URL nor authorize; a real URL then does", async () => {
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
    // A phrase with no extractable URL neither reports a URL nor enters authorizing.
    ptys[0]!.emitData(asScreen("Opening browser to authorize…"));
    await new Promise((r) => setTimeout(r, 150));
    expect(reported).toHaveLength(0);
    expect(ptys[0]!.writes).not.toContain("code");
    // Then a REAL claude.ai OAuth URL renders: it is reported, and only now does the
    // code prompt disclose the code.
    ptys[0]!.emitData(
      asScreen("Authenticate your account at:\nhttps://claude.ai/oauth/z\nPaste code here > "),
    );
    await expect.poll(() => ptys[0]!.writes.includes("code")).toBe(true);
    expect(reported).toEqual(["https://claude.ai/oauth/z"]);
    await succeedAndRecover(cwd, session);
    await expect(done).resolves.toBeUndefined();
  });
});
