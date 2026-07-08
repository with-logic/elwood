/**
 * Timeout-path unit tests for the typed wait helpers (fake timers).
 * Covers PRD §5.3 and C-API-34.
 */

import { describe, expect, test, vi } from "vitest";
import { sessionWaitForActivity, sessionWaitForStatus } from "../../src/core/session-wait.ts";
import { fakeSession, rejection } from "./session-wait-harness.ts";

describe("wait-helper timeouts", () => {
  test("C-API-34 status wait rejects with wait_timeout and unsubscribes", async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession("running");
      const pending = sessionWaitForStatus(session, (s) => s === "ready", 1000);
      const pendingRejection = rejection(pending);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await pendingRejection).code).toBe("wait_timeout");
      expect((await pendingRejection).message).toMatch(/status after 1000 ms/);
      expect(session.statusHandlers.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("C-API-34 activity wait rejects with wait_timeout and removes both subscriptions", async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession("running");
      const pending = sessionWaitForActivity(session, (e) => e.kind === "attention", 1000);
      const pendingRejection = rejection(pending);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await pendingRejection).code).toBe("wait_timeout");
      expect((await pendingRejection).message).toMatch(/activity after 1000 ms/);
      expect(session.activityHandlers.size).toBe(0);
      expect(session.statusHandlers.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("C-API-34 defaults the timeout to 60000 ms when omitted", async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession("running");
      const pending = sessionWaitForStatus(session, (s) => s === "ready");
      const pendingRejection = rejection(pending);
      // Still pending just before the default deadline.
      await vi.advanceTimersByTimeAsync(59_999);
      let settled = false;
      void pendingRejection.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pendingRejection).code).toBe("wait_timeout");
      expect((await pendingRejection).message).toMatch(/after 60000 ms/);
    } finally {
      vi.useRealTimers();
    }
  });
});
