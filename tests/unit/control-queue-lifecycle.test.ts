/**
 * Control-queue submission-lifecycle failure handling: readiness rollback,
 * turn-start listener throws, and background-nudge abort (PRD §5.3, C-API-19/31/35).
 */

import { describe, expect, test } from "vitest";
import { ControlQueue } from "../../src/core/control-queue.ts";

describe("ControlQueue submission lifecycle", () => {
  test("C-API-19 a rejected first submission restores readiness so later messages still drain", async () => {
    const submitted: string[] = [];
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        // The first submission's write rejects; no turn actually started.
        return input === "bad" ? Promise.reject(new Error("write failed")) : Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    const bad = queue.send("bad", "message");
    await expect(bad).rejects.toThrow("write failed");
    // Readiness was restored on the failure, so a later message drains WITHOUT
    // any Stop/ready signal — the queue is not wedged in a false `running` state.
    await queue.send("next", "message");
    expect(submitted).toEqual(["bad", "next"]);
  });

  test("C-API-35 a stale rollback does not clobber a markReady that arrived mid-write", async () => {
    const submitted: string[] = [];
    let release!: (reject: boolean) => void;
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        if (input !== "prompt") return Promise.resolve();
        return new Promise<void>((_resolve, reject) => {
          release = (r) => (r ? reject(new Error("write failed")) : _resolve());
        });
      },
      () => new Error("closed"),
      () => undefined,
    );
    // A prompt bypasses and dispatches while NOT ready; its write is still pending.
    const prompt = queue.send("prompt", "prompt");
    // A real turn-end arrives while the write is in flight → session is ready now.
    queue.markReady();
    // The prompt's write THEN fails. Rollback must NOT restore the stale `false`
    // (the epoch changed), or a queued message would be wedged unready forever.
    release(true);
    await expect(prompt).rejects.toThrow("write failed");
    await queue.send("after", "message");
    // The message drained because readiness from the mid-write markReady survived.
    expect(submitted).toEqual(["prompt", "after"]);
  });

  test("C-API-37 a stale rollback does not re-open readiness after a blocking suspend", async () => {
    const submitted: string[] = [];
    let release!: (reject: boolean) => void;
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        if (input !== "msg") return Promise.resolve();
        return new Promise<void>((_resolve, reject) => {
          release = (r) => (r ? reject(new Error("write failed")) : _resolve());
        });
      },
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    const msg = queue.send("msg", "message"); // dispatched while ready
    // A blocking dialog appears while the write is in flight → readiness suspended.
    queue.suspendReadiness();
    release(true); // the write then fails
    await expect(msg).rejects.toThrow("write failed");
    // Rollback must NOT restore the stale `true`: a follower stays HELD (would
    // otherwise be written into the dialog), until a real markReady reopens it.
    const held = queue.send("held", "message");
    expect(submitted).toEqual(["msg"]);
    queue.markReady();
    await held;
    expect(submitted).toEqual(["msg", "held"]);
  });

  test("C-API-35 a throwing turn-start listener aborts before the write, keeping ownership clean", async () => {
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
    // The first message's turn-start work throws BEFORE its write, so nothing is
    // written and the operation rejects; the queue stays consistent.
    await expect(queue.send("first", "message")).rejects.toThrow("status listener failed");
    expect(submitted).toEqual([]);
    // A follower still dispatches cleanly (no abandoned in-flight write).
    await queue.send("second", "message");
    expect(submitted).toEqual(["second"]);
  });

  test("C-API-07 a failed BYPASS submission never fabricates readiness the session lacked", async () => {
    const submitted: string[] = [];
    let running = false;
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return input === "prompt" ? Promise.reject(new Error("write failed")) : Promise.resolve();
      },
      () => new Error("closed"),
      () => {
        running = true;
      },
      () => running,
    );
    // Never ready: a prompt bypasses and dispatches while NOT ready, then fails.
    const prompt = queue.send("prompt", "prompt");
    await expect(prompt).rejects.toThrow("write failed");
    // Readiness must NOT be fabricated to `true`: a queued message stays held
    // until a real ready transition, exactly as before the failed bypass.
    const held = queue.send("held", "message");
    expect(submitted).toEqual(["prompt"]);
    queue.markReady();
    await held;
    expect(submitted).toEqual(["prompt", "held"]);
  });

  test("C-API-31 the prior submission's abort signal fires before the next dispatches", async () => {
    // A submission's background recovery nudges are cancelled when the next
    // operation begins, so an older nudge can't fire an Enter into a later paste.
    const signals: AbortSignal[] = [];
    const queue = new ControlQueue(
      (_input, _mode, signal) => {
        signals.push(signal);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    // Picker commands don't consume readiness, so two dispatch back-to-back.
    await queue.send("/model", "list_models");
    expect(signals[0]?.aborted).toBe(false);
    await queue.send("/model", "set_model");
    // Dispatching the second submission aborts the first's background work.
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  test("C-API-43 runExclusive cancel drops a QUEUED task, but is a no-op once dispatched", async () => {
    const queue = new ControlQueue(
      () => Promise.resolve(),
      () => new Error("closed"),
      () => undefined,
    );
    // A first exclusive task holds the lease; a running message keeps it in flight.
    let releaseFirst!: () => void;
    const first = queue.runExclusive("login", () => new Promise<void>((r) => (releaseFirst = r)));
    // A SECOND exclusive task queues behind it; its cancel fires while STILL QUEUED,
    // so it is dropped and rejected with cancel.error().
    const queuedCancel = new AbortController();
    const dropped = queue.runExclusive("login", () => Promise.resolve(), {
      signal: queuedCancel.signal,
      error: () => new Error("deadline"),
    });
    queuedCancel.abort();
    await expect(dropped).rejects.toThrow("deadline");

    // A cancel that fires AFTER a task has dispatched (is in flight) is a no-op —
    // it does not double-reject; the task settles normally when it completes. With
    // the queue now empty, runExclusive dispatches the task SYNCHRONOUSLY (drain
    // runs its `run` in the same tick), so it is already in flight on return.
    const dispatchedCancel = new AbortController();
    releaseFirst();
    await first;
    let releaseThird!: () => void;
    const third = queue.runExclusive("login", () => new Promise<void>((r) => (releaseThird = r)), {
      signal: dispatchedCancel.signal,
      error: () => new Error("late"),
    });
    dispatchedCancel.abort(); // already in flight → index < 0 → dropQueued returns, no reject
    releaseThird();
    await expect(third).resolves.toBeUndefined();
  });
});
