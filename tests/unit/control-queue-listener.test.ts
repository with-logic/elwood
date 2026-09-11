/**
 * Control-queue behavior when a turn-start (status) LISTENER throws: telemetry must
 * never abort a submission's write or wedge the queue (PRD §5.3, C-API-19/35).
 */

import { describe, expect, test } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

describe("ControlQueue turn-start listener containment", () => {
  test("C-API-35 a throwing turn-start listener is CONTAINED — the write still proceeds", async () => {
    const submitted: string[] = [];
    let started = 0;
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => {
        started += 1;
        if (started === 1) throw new Error("status listener failed");
      },
    );
    queue.markReady();
    // A throwing turn-start (status) listener is TELEMETRY: it must NOT abort the write
    // (the lifecycle transition already committed; aborting would drop into a rollback
    // that can't restore readiness and would wedge the queue). The message is delivered
    // and resolves normally despite the listener throw.
    await expect(queue.send("first", "message")).resolves.toBeUndefined();
    expect(submitted).toEqual(["first"]);
    // A follower still dispatches cleanly (no wedged queue, no abandoned in-flight). The
    // first message consumed readiness, so re-arm it as a real turn-end would.
    queue.markReady();
    await queue.send("second", "message");
    expect(submitted).toEqual(["first", "second"]);
  });

  test("C-API-35 a SYNCHRONOUSLY throwing exclusive task rejects and rolls back cleanly", async () => {
    const submitted: string[] = [];
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    // A runExclusive task whose synchronous body throws hits the dispatch catch: the op
    // rejects, readiness is restored (epoch unchanged — exclusive doesn't start a turn),
    // and the queue stays usable.
    await expect(
      queue.runExclusive("login", () => {
        throw new Error("sync task boom");
      }),
    ).rejects.toThrow("sync task boom");
    expect(submitted).toEqual([]);
    await queue.send("after", "message"); // queue not wedged; a follower still drains
    expect(submitted).toEqual(["after"]);
  });
});
