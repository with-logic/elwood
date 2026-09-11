/**
 * Listener/promise hygiene for the `/login` abort helpers (PRD §5.3, C-API-43).
 * A login flow polls the screen every 100 ms for up to minutes; each helper must
 * release its abort listener when it settles on the NORMAL path (not only on
 * abort), and a mid-wait abort must surface the typed error for its reason.
 */

import { getEventListeners } from "node:events";
import { describe, expect, test } from "vitest";
import { abortableDelay, pollDelay, raceSettle } from "../../src/claude/login/abort.ts";

const abortListeners = (signal: AbortSignal): number => getEventListeners(signal, "abort").length;

describe("login abort helpers release listeners on the normal path (C-API-43)", () => {
  test("raceSettle removes its abort listener once the work resolves", async () => {
    const controller = new AbortController();
    await expect(raceSettle(Promise.resolve("done"), controller.signal)).resolves.toBe("done");
    expect(abortListeners(controller.signal)).toBe(0);
  });

  test("raceSettle removes its abort listener once the work rejects", async () => {
    const controller = new AbortController();
    await expect(raceSettle(Promise.reject(new Error("boom")), controller.signal)).rejects.toThrow(
      "boom",
    );
    expect(abortListeners(controller.signal)).toBe(0);
  });

  test("pollDelay leaves no listener after a full interval elapses", async () => {
    const controller = new AbortController();
    await pollDelay(controller.signal);
    expect(abortListeners(controller.signal)).toBe(0);
  });

  test("repeated polls do not accumulate listeners", async () => {
    const controller = new AbortController();
    for (let i = 0; i < 5; i += 1) {
      await abortableDelay(1, controller.signal);
      await raceSettle(Promise.resolve(), controller.signal);
    }
    expect(abortListeners(controller.signal)).toBe(0);
  });
});

describe("login abort helpers surface the typed abort mid-wait (C-API-43)", () => {
  test("a deadline abort during a delay rejects with login_timeout", async () => {
    const controller = new AbortController();
    const pending = abortableDelay(60_000, controller.signal);
    controller.abort("deadline");
    await expect(pending).rejects.toMatchObject({ code: "login_timeout" });
    expect(abortListeners(controller.signal)).toBe(0);
  });

  test("a lifecycle abort during a delay rejects with session_not_running", async () => {
    const controller = new AbortController();
    const pending = pollDelay(controller.signal);
    controller.abort("aborted");
    await expect(pending).rejects.toMatchObject({ code: "session_not_running" });
  });

  test("a lifecycle abort during raced work rejects with session_not_running", async () => {
    const controller = new AbortController();
    const pending = raceSettle(new Promise<void>(() => {}), controller.signal);
    controller.abort("aborted");
    await expect(pending).rejects.toMatchObject({ code: "session_not_running" });
    expect(abortListeners(controller.signal)).toBe(0);
  });
});
