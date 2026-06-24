/**
 * Unit tests for queued adapter-neutral message submission.
 * Covers PRD §5.3 and C-API-19.
 */

import { describe, expect, test } from "vitest";
import { MessageQueue } from "../../src/core/message-queue.ts";

describe("MessageQueue", () => {
  test("C-API-19 submits immediately when ready and marks busy", async () => {
    const submitted: string[] = [];
    let busyCount = 0;
    const queue = new MessageQueue(
      (message) => submitted.push(message),
      () => new Error("closed"),
      () => busyCount++,
    );
    queue.markReady();
    await queue.send("one");
    expect(submitted).toEqual(["one"]);
    expect(busyCount).toBe(1);
    const queued = queue.send("two");
    expect(submitted).toEqual(["one"]);
    queue.markReady();
    await queued;
    expect(submitted).toEqual(["one", "two"]);
  });

  test("C-API-19 rejects queued and future messages after close", async () => {
    const queue = new MessageQueue(
      () => undefined,
      () => new Error("session_not_running"),
      () => undefined,
    );
    const queued = queue.send("later");
    queue.close();
    await expect(queued).rejects.toThrow("session_not_running");
    await expect(queue.send("future")).rejects.toThrow("session_not_running");
  });

  test("C-API-19 propagates submit failures", async () => {
    const queue = new MessageQueue(
      () => {
        throw new Error("raw failure");
      },
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    await expect(queue.send("boom")).rejects.toThrow("raw failure");
  });

  test("C-API-19 ignores running and ready after close", async () => {
    const queue = new MessageQueue(
      () => undefined,
      () => new Error("closed"),
      () => undefined,
    );
    queue.close();
    queue.markRunning();
    queue.markReady();
    await expect(queue.send("ignored")).rejects.toThrow("closed");
  });
});
