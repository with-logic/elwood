/**
 * At most eight probes run at once; the rest wait in arrival order, a probe that fails frees
 * its slot, and `runProbe` holds a slot for its whole run like any other probe. Covers PRD §9.2
 * and C-PERF-07.
 */

import { getEventListeners } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { withProbeSlot } from "../../src/runtime/probe/slots.ts";
import { tempDir } from "../helpers/tmp.ts";

/** C-PERF-07's cap, stated here rather than read from the implementation. */
const cap = 8;

/** A probe that records its start and runs until the test opens its gate. */
function held(started: string[], name: string, signal?: AbortSignal) {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const done = withProbeSlot(async () => {
    started.push(name);
    await gate;
  }, signal);
  return { open, done };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Opens every gate and waits for every probe, so a failed assertion never leaves slots held. */
async function finish(probes: readonly ReturnType<typeof held>[]): Promise<void> {
  for (const probe of probes) probe.open();
  await Promise.allSettled(probes.map((probe) => probe.done));
}

test("C-PERF-07 runs at most eight probes at once, then the longest waiter", async () => {
  const started: string[] = [];
  const probes = Array.from({ length: cap + 2 }, (_, i) => held(started, `p${i}`));
  try {
    await flush();
    expect(started).toHaveLength(cap);
    probes[3]?.open();
    await probes[3]?.done;
    await flush();
    expect(started).toEqual(probes.slice(0, cap + 1).map((_, i) => `p${i}`));
  } finally {
    await finish(probes);
  }
  expect(started).toHaveLength(cap + 2);
});

test("C-PERF-07 a probe that fails frees its slot", async () => {
  const started: string[] = [];
  const probes = Array.from({ length: cap - 1 }, (_, i) => held(started, `p${i}`));
  const failing = withProbeSlot(() => Promise.reject(new Error("spawn failed")));
  const waiter = held(started, "waiter");
  try {
    await expect(failing).rejects.toThrow("spawn failed");
    await flush();
    expect(started).toContain("waiter");
  } finally {
    await finish([...probes, waiter]);
  }
});

test.each([
  false,
  true,
])("C-PERF-07 an aborted probe leaves a full queue without waiting (aborted before queueing: %s)", async (alreadyAborted) => {
  const holders = Array.from({ length: cap }, (_, index) => held([], `h${index}`));
  const controller = new AbortController();
  const reason = new Error("session closed");
  if (alreadyAborted) controller.abort(reason);
  let cancellation: unknown;
  const probe = runProbe("/bin/sh", ["-c", "exit 0"], { signal: controller.signal }).catch(
    (error: unknown) => {
      cancellation = error;
    },
  );
  const started: string[] = [];
  const next = held(started, "next");
  try {
    if (!alreadyAborted) controller.abort(reason);
    await flush();
    expect(cancellation).toBe(reason);
    expect(started).toEqual([]);
    holders[0]?.open();
    await flush();
    expect(started).toEqual(["next"]);
  } finally {
    await finish([...holders, next]);
    await probe;
  }
});

test("C-PERF-07 canceling waiters at either end and in the middle keeps surviving probes in arrival order", async () => {
  const holders = Array.from({ length: cap }, (_, index) => held([], `h${index}`));
  const started: string[] = [];
  const head = new AbortController();
  const middle = new AbortController();
  const tail = new AbortController();
  const canceledHead = held(started, "head", head.signal);
  const first = held(started, "first");
  const canceledMiddle = held(started, "middle", middle.signal);
  const second = held(started, "second");
  const canceledTail = held(started, "tail", tail.signal);
  const canceled = Promise.allSettled([canceledHead.done, canceledMiddle.done, canceledTail.done]);
  const reason = new Error("session closed");
  middle.abort(reason);
  head.abort(reason);
  tail.abort(reason);
  const third = held(started, "third");
  try {
    expect(await canceled).toEqual(
      Array.from({ length: 3 }, () => ({ status: "rejected", reason })),
    );
    expect(started).toEqual([]);
    holders[0]!.open();
    await finish([first, second, third]);
    expect(started).toEqual(["first", "second", "third"]);
  } finally {
    await finish([...holders, first, second, third]);
  }
});

test("C-PERF-07 runProbe holds a slot until its command exits", async () => {
  const holders = Array.from({ length: cap - 1 }, (_, i) => held([], `h${i}`));
  const release = join(tempDir("elwood-probe-slot-"), "release");
  // Takes the last free slot and keeps it until the test creates `release`.
  const probe = runProbe("/bin/sh", [
    "-c",
    `while [ ! -e '${release}' ]; do sleep 0.01; done; echo ran`,
  ]);
  let nextRan = false;
  const controller = new AbortController();
  const next = withProbeSlot(() => {
    nextRan = true;
    return Promise.resolve();
  }, controller.signal);
  try {
    await flush();
    expect(nextRan, "a waiter must not run while the probe holds the last slot").toBe(false);
    writeFileSync(release, "");
    await expect(probe).resolves.toMatchObject({ status: 0, stdout: "ran\n" });
    await next;
    expect(nextRan).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  } finally {
    writeFileSync(release, "");
    await finish(holders);
    await Promise.allSettled([probe, next]);
  }
});
