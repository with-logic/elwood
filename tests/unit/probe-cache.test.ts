/**
 * The bounded probe cache: shared in-flight runs, least-recently-used eviction of settled
 * successes only, no retained rejections, and runs that settle after `clear()`.
 * Covers PRD §9.2 (C-PERF-02) and C-LIFE-11.
 */

import { expect, test } from "vitest";
import { createProbeCache } from "../../src/runtime/probe-cache.ts";

/** A run whose settlement the test controls, counting how often each key was run. */
function controlled() {
  const runs: string[] = [];
  const pending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  const run = (key: string) => () => {
    runs.push(key);
    return new Promise<string>((resolve, reject) => pending.set(key, { resolve, reject }));
  };
  const settle = async (key: string, outcome: string | Error) => {
    const handle = pending.get(key);
    if (outcome instanceof Error) handle?.reject(outcome);
    else handle?.resolve(outcome);
    await Promise.resolve();
  };
  return { runs, run, settle };
}

const ok = (value: string) => () => Promise.resolve(value);

test("C-PERF-02 concurrent callers share one in-flight run, and later callers its result", async () => {
  const cache = createProbeCache<string>(2);
  const { runs, run, settle } = controlled();
  const first = cache.get("a", run("a"));
  expect(cache.get("a", run("a"))).toBe(first);
  await settle("a", "A");
  await expect(first).resolves.toBe("A");
  await expect(cache.get("a", run("a"))).resolves.toBe("A");
  expect(runs).toEqual(["a"]);
});

test("C-LIFE-11 a rejected run is not kept, so the next caller runs again", async () => {
  const cache = createProbeCache<string>(2);
  const { runs, run, settle } = controlled();
  const failed = cache.get("a", run("a"));
  await settle("a", new Error("boom"));
  await expect(failed).rejects.toThrow("boom");
  const retry = cache.get("a", run("a"));
  await settle("a", "A");
  await expect(retry).resolves.toBe("A");
  expect(runs).toEqual(["a", "a"]);
});

test("C-LIFE-11 a settled value its probe calls failed is shared in flight but not kept", async () => {
  let runs = 0;
  const run = () => Promise.resolve(++runs === 1 ? "failed" : "ok");
  const cache = createProbeCache<string>(2, (value) => value !== "failed");
  expect(await Promise.all([cache.get("k", run), cache.get("k", run)])).toEqual([
    "failed",
    "failed",
  ]);
  expect([await cache.get("k", run), await cache.get("k", run), runs]).toEqual(["ok", "ok", 2]);
});

test("C-PERF-02 only the most recently used settled results are kept", async () => {
  const cache = createProbeCache<string>(2);
  await cache.get("a", ok("A"));
  await cache.get("b", ok("B"));
  await cache.get("a", ok("unused")); // a is now more recent than b
  await cache.get("c", ok("C")); // evicts b, the least recently used
  await expect(cache.get("a", ok("again"))).resolves.toBe("A");
  await expect(cache.get("c", ok("again"))).resolves.toBe("C");
  await expect(cache.get("b", ok("B2"))).resolves.toBe("B2");
});

test("C-PERF-02 eviction never drops an in-flight run", async () => {
  const cache = createProbeCache<string>(1);
  const { runs, run, settle } = controlled();
  const slow = cache.get("slow", run("slow"));
  await cache.get("x", ok("X"));
  await cache.get("y", ok("Y")); // the settled bound is full twice over meanwhile
  expect(cache.get("slow", run("slow"))).toBe(slow);
  await settle("slow", "S");
  await expect(cache.get("slow", run("slow"))).resolves.toBe("S");
  expect(runs).toEqual(["slow"]);
});

test("C-PERF-02 a run that settles after clear() is not kept and cannot evict its successor", async () => {
  const cache = createProbeCache<string>(2);
  const { runs, run, settle } = controlled();
  const stale = cache.get("a", run("stale"));
  cache.clear();
  const fresh = cache.get("a", run("fresh"));
  await settle("stale", new Error("late"));
  await expect(stale).rejects.toThrow("late");
  expect(cache.get("a", ok("unused"))).toBe(fresh); // still in flight and shared
  await settle("fresh", "F");
  await expect(cache.get("a", ok("unused"))).resolves.toBe("F");
  const staleSuccess = cache.get("b", run("stale b"));
  cache.clear();
  const freshB = cache.get("b", run("fresh b"));
  await settle("stale b", "late B");
  await expect(staleSuccess).resolves.toBe("late B");
  expect(cache.get("b", ok("unused"))).toBe(freshB); // the late success did not replace it
  await settle("fresh b", "B2");
  await expect(cache.get("b", ok("unused"))).resolves.toBe("B2");
  expect(runs).toEqual(["stale", "fresh", "stale b", "fresh b"]);
});
