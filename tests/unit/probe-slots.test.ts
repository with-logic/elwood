/**
 * At most `maxConcurrentProbes` probes run at once; the rest wait in arrival order, a probe
 * that fails frees its slot, and `runProbe` takes a slot like any other probe. Covers PRD §9.2
 * and C-PERF-07.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { maxConcurrentProbes, withProbeSlot } from "../../src/runtime/probe/slots.ts";
import { tempDir } from "../helpers/tmp.ts";

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

async function finish(probes: readonly ReturnType<typeof held>[]): Promise<void> {
  for (const probe of probes) probe.open();
  await Promise.all(probes.map((probe) => probe.done));
}

test("C-PERF-07 runs at most maxConcurrentProbes probes at once, then the longest waiter", async () => {
  const started: string[] = [];
  const probes = Array.from({ length: maxConcurrentProbes + 2 }, (_, i) => held(started, `p${i}`));
  await flush();
  expect(started).toHaveLength(maxConcurrentProbes);
  probes[3]?.open();
  await probes[3]?.done;
  await flush();
  expect(started).toEqual(probes.slice(0, maxConcurrentProbes + 1).map((_, i) => `p${i}`));
  await finish(probes);
  expect(started).toHaveLength(maxConcurrentProbes + 2);
});

test("C-PERF-07 a probe that fails frees its slot", async () => {
  const started: string[] = [];
  const probes = Array.from({ length: maxConcurrentProbes - 1 }, (_, i) => held(started, `p${i}`));
  const failing = withProbeSlot(() => Promise.reject(new Error("spawn failed")));
  const waiter = held(started, "waiter");
  await expect(failing).rejects.toThrow("spawn failed");
  await flush();
  expect(started).toContain("waiter");
  await finish([...probes, waiter]);
});

test("C-PERF-07 runProbe takes a slot like any other probe", async () => {
  const holders = Array.from({ length: maxConcurrentProbes }, (_, i) => held([], `h${i}`));
  const marker = join(tempDir("elwood-probe-slot-"), "ran");
  const probe = runProbe("/bin/sh", ["-c", `echo ran > '${marker}'`]);
  // Queued after the probe, so it starts only once the probe has run and freed its slot.
  const next = withProbeSlot(async () => existsSync(marker));
  holders[0]?.open();
  await expect(probe).resolves.toMatchObject({ status: 0 });
  expect(await next).toBe(true);
  await finish(holders);
});
