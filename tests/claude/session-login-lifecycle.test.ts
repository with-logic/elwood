/**
 * Lifecycle & concurrency conformance for ClaudeSession.login (PRD §5.3,
 * C-API-43). Login runs as an EXCLUSIVE control-queue task: a concurrent
 * sendMessage cannot interleave its keystrokes with the secret code or picker
 * keys, a session that terminates mid-flow rejects the flow PROMPTLY (close()
 * aborts the in-flight signal) rather than polling out the deadline, and a
 * provideCode callback that hangs is raced against the timeout.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { driveFreshReady, ready, succeedAndRecover } from "./login-helpers.ts";

afterEach(resetFakes);

const PASTED = (text: string) => `\u001b[200~${text}\u001b[201~`;

describe("ClaudeSession.login lifecycle (C-API-43)", () => {
  test("C-API-43 a concurrent sendMessage does NOT interleave with an in-flight login", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);

    const done = session.login({ provideCode: () => "x", timeoutMs: 5_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // Reach a stable mid-flow state (picker on screen, waiting to advance).
    ptys[0]!.emitData(asScreen("Select login method:\n Claude account with subscription"));
    await expect.poll(() => ptys[0]!.writes.includes("\r")).toBe(true);

    // A concurrent message enqueues BEHIND the exclusive login lease.
    const pasted = PASTED("interleaving-message");
    const message = session.sendMessage("interleaving-message");
    // Give the queue several ticks: the message's bracketed paste must NOT appear
    // while login still owns the queue.
    await new Promise((r) => setTimeout(r, 200));
    expect(ptys[0]!.writes).not.toContain(pasted);

    // Drive login to completion; only THEN may the queued message dispatch.
    await succeedAndRecover(cwd, session);
    await done;
    await message;
    expect(ptys[0]!.writes).toContain(pasted);
    // And it landed strictly AFTER login's writes.
    expect(ptys[0]!.writes.indexOf(pasted)).toBeGreaterThan(ptys[0]!.writes.indexOf("/login"));
    // This test chains a full startup + login + fresh-ready + a queued message
    // dispatch, so it needs more than the 5s default under full-suite CPU pressure
    // (isolation completes in well under a second — the extra budget is scheduling
    // headroom, not a masked hang).
  }, 20_000);

  test("C-API-43 killing the session mid-flow rejects login with session_not_running promptly", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);

    const done = session.login({ provideCode: () => "x", timeoutMs: 60_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    ptys[0]!.emitData(asScreen("Select login method:\n Claude account with subscription"));
    await expect.poll(() => ptys[0]!.writes.includes("\r")).toBe(true);

    // Terminate mid-flow: close() aborts the in-flight signal, so the flow settles
    // immediately instead of polling out the (60s) deadline.
    const start = Date.now();
    await session.kill();
    await expect(done).rejects.toMatchObject({ code: "session_not_running" });
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("C-API-43 a hanging provideCode callback still rejects with login_timeout", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);

    // provideCode never resolves; the callback is raced against the short deadline.
    const done = session.login({
      provideCode: () => new Promise<string>(() => {}),
      timeoutMs: 300,
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    ptys[0]!.emitData(
      asScreen("Authenticate your account at:\nhttps://claude.ai/oauth/x\nPaste code here > "),
    );
    await expect(done).rejects.toMatchObject({ code: "login_timeout" });
  });

  test("C-API-43 the /login write HOLDS while a blocking dialog is on screen", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);
    // A blocking dialog is on screen BEFORE login() is called; dialog safety means
    // NO login keystroke — not even `/login` — may land while blocked (it would
    // confirm the dialog's highlighted option).
    ptys[0]!.emitData("Do you want to run this?\r\n ❯ 1. Yes\r\n   3. No\r\n Esc to cancel\r\n");
    await expect.poll(() => session.status).toBe("blocked");

    const done = session.login({ provideCode: () => "x", timeoutMs: 5_000 });
    // The whole submission is HELD: `/login` is not written while blocked.
    await new Promise((r) => setTimeout(r, 200));
    expect(ptys[0]!.writes).toEqual([]);
    // The dialog clears; `/login` (and the flow) proceeds and completes.
    ptys[0]!.emitData(asScreen("Select login method:\n Claude account with subscription"));
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    await succeedAndRecover(cwd, session);
    await expect(done).resolves.toBeUndefined();
  }, 20_000);

  test("C-API-43 a ready that fired BEFORE success does not satisfy usability", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);

    const done = session.login({ provideCode: () => "x", timeoutMs: 800 });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    // A running→ready transition happens BEFORE the success banner. `awaitUsable`
    // waits for a ready STRICTLY AFTER success is detected, so this earlier ready
    // must NOT resolve login — it times out (no post-success ready ever arrives).
    await driveFreshReady(cwd, session);
    await expect.poll(() => session.status).toBe("ready");
    ptys[0]!.emitData(asScreen("Login successful."));
    // Deliberately do NOT drive a post-success ready → login times out.
    await expect(done).rejects.toMatchObject({ code: "login_timeout" });
  }, 20_000);

  // A provideCode that throws (an Error OR a bare non-Error value) surfaces
  // login_failed, not a swallowed success — exercising both `cause` shapes.
  const throwers: readonly [label: string, make: () => unknown][] = [
    ["an Error", () => new Error("clipboard unavailable")],
    ["a non-Error value", () => "clipboard string fault"],
  ];
  test.each(
    throwers,
  )("C-API-43 a provideCode that throws %s rejects with login_failed", async (_l, make) => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ready(cwd, session);

    const done = session.login({
      provideCode: () => {
        throw make();
      },
      timeoutMs: 5_000,
    });
    await expect.poll(() => ptys[0]!.writes.includes("/login")).toBe(true);
    ptys[0]!.emitData(
      asScreen("Authenticate your account at:\nhttps://claude.ai/oauth/x\nPaste code here > "),
    );
    await expect(done).rejects.toMatchObject({ code: "login_failed" });
  });
});
