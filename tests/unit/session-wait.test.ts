/**
 * Unit tests for the typed status/activity wait helpers (resolve/reject paths).
 * Covers PRD §5.3 and C-API-34. Timeout paths live in session-wait-timeout.
 */

import { describe, expect, test } from "vitest";
import {
  sessionWaitForActivity,
  sessionWaitForStatus,
  waitForStatus,
} from "../../src/core/session-wait.ts";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";
import { activity, fakeSession, rejection } from "./session-wait-harness.ts";

describe("sessionWaitForStatus", () => {
  test("C-API-34 resolves immediately when the current status already matches", async () => {
    const session = fakeSession("ready");
    await expect(sessionWaitForStatus(session, (s) => s === "ready")).resolves.toBe("ready");
    expect(session.statusHandlers.size).toBe(0);
  });

  test("C-API-34 resolves on a future matching status and unsubscribes", async () => {
    const session = fakeSession("running");
    const pending = sessionWaitForStatus(session, (s) => s === "ready");
    session.emitStatus("ready");
    await expect(pending).resolves.toBe("ready");
    expect(session.statusHandlers.size).toBe(0);
  });

  test("C-API-34 ignores non-matching non-terminal statuses and resolves later", async () => {
    const session = fakeSession("running");
    const pending = sessionWaitForStatus(session, (s) => s === "ready");
    session.emitStatus("blocked");
    session.emitStatus("ready");
    await expect(pending).resolves.toBe("ready");
  });

  test("C-API-34 rejects with session_not_running on an unwaited terminal status", async () => {
    const session = fakeSession("running");
    const pending = sessionWaitForStatus(session, (s) => s === "blocked");
    session.emitStatus("exited");
    expect((await rejection(pending)).code).toBe("session_not_running");
  });

  test("C-API-34 rejects immediately when already terminal and unmatched", async () => {
    const session = fakeSession("exited");
    const pending = sessionWaitForStatus(session, (s) => s === "ready");
    expect((await rejection(pending)).code).toBe("session_not_running");
    expect(session.statusHandlers.size).toBe(0);
  });

  test("C-API-34 a throwing predicate rejects the wait instead of escaping", async () => {
    const boom = () => {
      throw new Error("predicate boom");
    };
    // Throws on the immediate current-status check → rejected promise.
    const session = fakeSession("running");
    expect((await rejection(sessionWaitForStatus(session, boom))).message).toBe("predicate boom");
    // Throws inside an event callback → rejects and unsubscribes.
    let calls = 0;
    const later = fakeSession("running");
    const pending = sessionWaitForStatus(later, () => {
      calls += 1;
      if (calls > 1) throw new Error("late boom");
      return false;
    });
    later.emitStatus("blocked");
    expect((await rejection(pending)).message).toBe("late boom");
    expect(later.statusHandlers.size).toBe(0);
  });

  test("C-API-34 a non-Error thrown by a predicate is wrapped in an Error", async () => {
    const session = fakeSession("running");
    const pending = sessionWaitForStatus(session, () => {
      // biome-ignore lint/style/useThrowOnlyError: exercising the non-Error throw path.
      throw "string failure";
    });
    expect((await rejection(pending)).message).toBe("string failure");
  });

  test("C-API-34 a second matching event after settle is a no-op", async () => {
    // A handler that fires twice before unsubscribe takes effect (e.g. two
    // synchronous status emits) must settle exactly once.
    let handler: ((status: ElwoodSessionStatus) => void) | undefined;
    const pending = waitForStatus(
      {
        current: () => "running",
        // Keep the captured handler callable even after unsubscribe so the
        // second invocation reaches the settler's already-settled guard.
        onStatus: (h) => {
          handler = h;
          return () => {};
        },
      },
      (s) => s === "ready",
    );
    handler?.("ready");
    expect(() => handler?.("ready")).not.toThrow();
    await expect(pending).resolves.toBe("ready");
  });
});

describe("sessionWaitForActivity", () => {
  test("C-API-34 resolves on the first matching activity and clears both listeners", async () => {
    const session = fakeSession("running");
    const pending = sessionWaitForActivity(session, (e) => e.kind === "attention");
    session.emitActivity(activity("tool_call"));
    session.emitActivity(activity("attention"));
    await expect(pending).resolves.toMatchObject({ kind: "attention" });
    expect(session.activityHandlers.size).toBe(0);
    expect(session.statusHandlers.size).toBe(0);
  });

  test("C-API-34 rejects immediately when the session is already terminal", async () => {
    const session = fakeSession("exited");
    const error = await rejection(sessionWaitForActivity(session, () => true));
    expect(error.code).toBe("session_not_running");
  });

  test("C-API-34 ignores non-terminal status changes while waiting for activity", async () => {
    const session = fakeSession("running");
    const pending = sessionWaitForActivity(session, (e) => e.kind === "attention");
    session.emitStatus("blocked");
    session.emitActivity(activity("attention"));
    await expect(pending).resolves.toMatchObject({ kind: "attention" });
  });

  test("C-API-34 rejects when the session terminates before the activity", async () => {
    const session = fakeSession("running");
    const pending = sessionWaitForActivity(session, (e) => e.kind === "attention");
    session.emitStatus("stopped");
    expect((await rejection(pending)).code).toBe("session_not_running");
    expect(session.activityHandlers.size).toBe(0);
  });

  test("C-API-34 a throwing activity predicate rejects and unsubscribes", async () => {
    const session = fakeSession("running");
    const pending = sessionWaitForActivity(session, () => {
      throw new Error("activity boom");
    });
    session.emitActivity(activity("attention"));
    expect((await rejection(pending)).message).toBe("activity boom");
    expect(session.activityHandlers.size).toBe(0);
    expect(session.statusHandlers.size).toBe(0);
  });
});
