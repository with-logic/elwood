/**
 * Focused coverage for the `/login` untrusted-input validators and the flow's
 * abort composition (PRD §5.3, C-API-43). `safeAuthUrl` gates the scraped browser
 * URL by protocol, embedded credentials, and host allowlist; `isSafeAuthCode`
 * rejects control-bearing / oversized / empty codes; and the abort helpers reject
 * IMMEDIATELY when their signal is already aborted (the deadline already elapsed).
 */

import { describe, expect, test } from "vitest";
import { deadlineSignal, pollDelay, raceSettle } from "../../src/claude/login/abort.ts";
import { isSafeAuthCode, safeAuthUrl } from "../../src/claude/login/validate.ts";

describe("safeAuthUrl (C-API-43)", () => {
  test("accepts every approved https OAuth host", () => {
    for (const host of [
      "claude.ai",
      "claude.com",
      "platform.claude.com",
      "console.anthropic.com",
    ]) {
      expect(safeAuthUrl(`https://${host}/oauth/authorize?a=1`)).toBe(
        `https://${host}/oauth/authorize?a=1`,
      );
    }
  });

  test("rejects non-https, embedded credentials, off-host, and unparseable URLs", () => {
    expect(safeAuthUrl("http://claude.ai/oauth/x")).toBeUndefined(); // plain http
    expect(safeAuthUrl("ftp://claude.ai/oauth/x")).toBeUndefined(); // other scheme
    expect(safeAuthUrl("https://user:pass@claude.ai/oauth/x")).toBeUndefined(); // credentials
    expect(safeAuthUrl("https://user@claude.ai/oauth/x")).toBeUndefined(); // username only
    expect(safeAuthUrl("https://evilclaude.com/oauth/x")).toBeUndefined(); // look-alike host
    expect(safeAuthUrl("not a url")).toBeUndefined(); // unparseable
    expect(safeAuthUrl("")).toBeUndefined();
  });
});

describe("isSafeAuthCode (C-API-43)", () => {
  test("accepts a printable single-line code and rejects control/oversized/empty", () => {
    expect(isSafeAuthCode("AUTH-CODE-123")).toBe(true);
    expect(isSafeAuthCode("x".repeat(512))).toBe(true); // exactly the max length
    expect(isSafeAuthCode("")).toBe(false);
    expect(isSafeAuthCode("x".repeat(513))).toBe(false); // over the max
    expect(isSafeAuthCode("GOOD\rENTER")).toBe(false); // CR
    expect(isSafeAuthCode(`GOOD${String.fromCharCode(27)}[B`)).toBe(false); // ESC
    expect(isSafeAuthCode(`GOOD${String.fromCharCode(0)}`)).toBe(false); // NUL
    expect(isSafeAuthCode(`GOOD${String.fromCharCode(0x2028)}`)).toBe(false); // line separator
  });
});

describe("abort helpers reject immediately when already aborted (C-API-43)", () => {
  const aborted = (): AbortSignal => {
    const controller = new AbortController();
    controller.abort("deadline");
    return controller.signal;
  };

  test("raceSettle surfaces the abort even against pending work", async () => {
    await expect(raceSettle(new Promise<void>(() => {}), aborted())).rejects.toMatchObject({
      code: "login_timeout",
    });
  });

  test("pollDelay rejects at once on a pre-aborted signal", async () => {
    await expect(pollDelay(aborted())).rejects.toMatchObject({ code: "login_timeout" });
  });

  test("a parent-aborted deadlineSignal surfaces session_not_running", async () => {
    const parent = new AbortController();
    parent.abort();
    const { signal, cancel } = deadlineSignal(60_000, parent.signal);
    await expect(raceSettle(new Promise<void>(() => {}), signal)).rejects.toMatchObject({
      code: "session_not_running",
    });
    cancel();
  });
});
