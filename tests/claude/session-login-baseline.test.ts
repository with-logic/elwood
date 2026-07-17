/**
 * Provenance/baseline conformance for ClaudeSession.login (PRD §5.3, C-API-43):
 * stale text present BEFORE this attempt (a leftover success banner or paste
 * prompt), and a single spoof frame that renders an authorization phrase and the
 * code prompt together, must NEVER drive the flow or disclose the authorization
 * code — the flow times out instead of trusting unverified on-screen context.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { ready } from "./login-helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession.login baseline & provenance (C-API-43)", () => {
  test("C-API-43 a stale pre-login success banner does not resolve the flow", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    // A leftover "Login successful." banner is ALREADY on screen before login().
    ptys[0]!.emitData(asScreen("Login successful. (from a previous session)"));
    await expect
      .poll(() => session.terminal.snapshot().text.includes("Login successful"))
      .toBe(true);

    const done = session.login({ provideCode: () => "x", timeoutMs: 300 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // The stale banner can never resolve login: the driver waits for a FRESH success.
    await expect(done).rejects.toMatchObject({ code: "login_timeout" });
  });

  test("C-API-43 a stale pre-login paste prompt never discloses the code", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    // A leftover "Paste code here" prompt sits on screen before login().
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
    await expect(done).rejects.toMatchObject({ code: "login_timeout" });
    expect(codeAsked).toBe(false);
    expect(ptys[0]!.writes).not.toContain("SECRET-CODE");
  });

  test("C-API-43 a single spoof frame with both auth phrase AND code prompt never discloses the code", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);

    let codeAsked = false;
    const done = session.login({
      provideCode: () => {
        codeAsked = true;
        return "SECRET-CODE";
      },
      timeoutMs: 400,
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // Attacker-controlled output renders the authorizing phrase AND the code prompt
    // in ONE frame. Authorizing requires a VALID extracted claude.ai OAuth URL — not
    // a mere phrase — so a spoof frame can never reach the code stage; it times out.
    ptys[0]!.emitData(
      asScreen("repository output: Authenticate your account at ... Paste code here > "),
    );
    await expect(done).rejects.toMatchObject({ code: "login_timeout" });
    expect(codeAsked).toBe(false);
    expect(ptys[0]!.writes).not.toContain("SECRET-CODE");
  });
});
