/**
 * At most eight probes run at once; the rest wait in arrival order, a probe that fails frees
 * its slot, and `runProbe` holds a slot for its whole run like any other probe. Covers PRD §9.2
 * and C-PERF-07.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { withProbeSlot } from "../../src/runtime/probe/slots.ts";
import { tempDir } from "../helpers/tmp.ts";

/** C-PERF-07's cap, stated here rather than read from the implementation. */
const cap = 8;

/** A probe that records its start and runs until the test opens its gate. */
function held(started: string[], name: string) {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const done = withProbeSlot(async () => {
    started.push(name);
    await gate;
  });
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

test("C-PERF-07 runProbe holds a slot until its command exits", async () => {
  const holders = Array.from({ length: cap - 1 }, (_, i) => held([], `h${i}`));
  const release = join(tempDir("elwood-probe-slot-"), "release");
  // Takes the last free slot and keeps it until the test creates `release`.
  const probe = runProbe("/bin/sh", [
    "-c",
    `while [ ! -e '${release}' ]; do sleep 0.01; done; echo ran`,
  ]);
  let nextRan = false;
  const next = withProbeSlot(() => {
    nextRan = true;
    return Promise.resolve();
  });
  try {
    await flush();
    expect(nextRan, "a waiter must not run while the probe holds the last slot").toBe(false);
    writeFileSync(release, "");
    await expect(probe).resolves.toMatchObject({ status: 0, stdout: "ran\n" });
    await next;
    expect(nextRan).toBe(true);
  } finally {
    writeFileSync(release, "");
    await finish(holders);
    await Promise.allSettled([probe, next]);
  }
});
