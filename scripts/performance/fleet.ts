/** Measures only Elwood's 50-session runtime; no real agent/model calls (PRD §9.2). */
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Executable benchmark correctness checks.
import assert from "node:assert/strict";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createFleet } from "./fleet-runtime.ts";
import { exerciseFleet } from "./fleet-workload.ts";

const count = Number(process.env["ELWOOD_BENCH_SESSIONS"] ?? 50);
const rounds = Number(process.env["ELWOOD_BENCH_ROUNDS"] ?? 80);
assert.ok(Number.isSafeInteger(count) && count > 0);
assert.ok(Number.isSafeInteger(rounds) && rounds > 0);
const initialResources = process.getActiveResourcesInfo();
const started = performance.now();
const fleet = await createFleet(count);
const setupMs = performance.now() - started;
let result: Record<string, unknown>;
try {
  await delay(100);
  globalThis.gc?.();
  const idleCpu = process.cpuUsage();
  await delay(2_000);
  const idle = process.cpuUsage(idleCpu);
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  const activeCpu = process.cpuUsage();
  const before = performance.now();
  const counts = await exerciseFleet(fleet, rounds);
  const elapsedMs = performance.now() - before;
  const cpu = process.cpuUsage(activeCpu);
  loop.disable();
  globalThis.gc?.();
  const memory = process.memoryUsage();
  result = {
    sessions: count,
    rounds,
    setupMs,
    activeCpuMs: (cpu.user + cpu.system) / 1_000,
    idleCpuMs: (idle.user + idle.system) / 1_000,
    heapMiB: memory.heapUsed / 1024 ** 2,
    rssMiB: memory.rss / 1024 ** 2,
    externalMiB: memory.external / 1024 ** 2,
    latencyP99Ms: loop.percentile(99) / 1e6,
    latencyMaxMs: loop.max / 1e6,
    elapsedMs,
    ...counts,
    correct: 1,
  };
} finally {
  await fleet.dispose();
}
await delay(100);
globalThis.gc?.();
const resources = process
  .getActiveResourcesInfo()
  .filter((name) => !initialResources.includes(name));
assert.deepEqual(resources, []);
process.stdout.write(
  `${JSON.stringify({
    ...result,
    leakedResources: resources.length,
    retainedHeapMiB: process.memoryUsage().heapUsed / 1024 ** 2,
    node: process.version,
  })}\n`,
);
