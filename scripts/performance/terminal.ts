/**
 * Repeatable real-PTY rendering load probe for PRD §4.1 and C-PERF-06.
 * Run: node --expose-gc --no-warnings scripts/performance/terminal.ts [MiB] [sessions...]
 * Measures the parent renderer; child-process memory is outside these measurements.
 */

import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { nodePtyFactory } from "../../src/pty/node.ts";
import type { PtyProcess } from "../../src/pty/types.ts";
import { attachPtyTerminal } from "../../src/terminal/headless.ts";
import { frameObserver } from "./frame-observer.ts";

const mib = Number(process.argv[2] ?? 1);
const counts = process.argv.slice(3).map(Number);
const ptySize = { cols: 120, rows: 40 };
/** The PTY line discipline (ONLCR) rewrites each `\n` the child writes as `\r\n`. */
const ptyNewlineExpansionBytes = 1;
if (counts.length === 0) counts.push(1, 8, 32);
if (
  !Number.isSafeInteger(mib) ||
  mib < 1 ||
  counts.some((n) => !Number.isSafeInteger(n) || n < 1)
) {
  throw new Error("Expected positive integer MiB and session counts.");
}

for (const count of counts) process.stdout.write(`${JSON.stringify(await measure(count, mib))}\n`);

async function measure(count: number, mibPerSession: number) {
  globalThis.gc?.();
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  let peakHeap = baseline.heapUsed;
  const sampler = setInterval(() => {
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeap = Math.max(peakHeap, usage.heapUsed);
  }, 10);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const startedAtMs = performance.now();
  let results: Awaited<ReturnType<typeof renderSession>>[];
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: count }, (_, i) => renderSession(i, mibPerSession)),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0) throw new AggregateError(failures, "Terminal load probe failed");
    results = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
  } finally {
    loop.disable();
    clearInterval(sampler);
  }
  const elapsedMs = performance.now() - startedAtMs;
  await delay(50);
  globalThis.gc?.();
  const after = process.memoryUsage();
  return {
    sessions: count,
    frameObserver: process.env["ELWOOD_BENCH_AGENT"] ?? "snapshot",
    mibPerSession,
    elapsedMs: Math.round(elapsedMs),
    mibPerSecond: Math.round((count * mibPerSession * 1000) / elapsedMs),
    peakRssMiB: Math.round(peakRss / 1024 ** 2),
    peakHeapMiB: Math.round(peakHeap / 1024 ** 2),
    retainedHeapMiB: Number(((after.heapUsed - baseline.heapUsed) / 1024 ** 2).toFixed(2)),
    eventLoopP99Ms: Number((loop.percentile(99) / 1e6).toFixed(1)),
    eventLoopMaxMs: Number((loop.max / 1e6).toFixed(1)),
    maxQueuedBytes: Math.max(...results.map((r) => r.maxQueuedBytes)),
    pauseCalls: results.reduce((total, r) => total + r.pauseCalls, 0),
    childExitToRenderMs: Math.max(...results.map((r) => r.childExitToRenderMs)),
    chunks: results.reduce((total, r) => total + r.chunks, 0),
    renderBatches: results.reduce((total, r) => total + r.renderBatches, 0),
    activeResourcesAfterCleanup: process.getActiveResourcesInfo(),
  };
}

async function renderSession(sessionIndex: number, mibPerSession: number) {
  // Validate the observer configuration before any child PTY exists to leak.
  const observeFrame = frameObserver(String(sessionIndex));
  const marker = `ELWOOD_RENDER_COMPLETE_${sessionIndex}`;
  const final = `\n${marker}\n`;
  const finalNewlines = final.split("\n").length - 1;
  const expectedBytes =
    mibPerSession * 1024 ** 2 + Buffer.byteLength(final) + finalNewlines * ptyNewlineExpansionBytes;
  const writer = `
    const chunk = "x".repeat(4096);
    let remaining = ${mibPerSession * 256};
    function write() {
      while (remaining > 0) {
        remaining--;
        if (!process.stdout.write(chunk)) return process.stdout.once("drain", write);
      }
      process.stdout.write(${JSON.stringify(final)});
    }
    write();
  `;
  const raw = nodePtyFactory({
    command: process.execPath,
    args: ["-e", writer],
    cwd: process.cwd(),
    env: process.env,
    size: ptySize,
  });
  let queuedBytes = 0;
  let renderedBytes = 0;
  let maxQueuedBytes = 0;
  let pauseCalls = 0;
  let chunks = 0;
  let renderBatches = 0;
  const pty: PtyProcess = {
    ...raw,
    onData: (handler) =>
      raw.onData((data) => {
        chunks++;
        queuedBytes += Buffer.byteLength(data);
        maxQueuedBytes = Math.max(maxQueuedBytes, queuedBytes);
        handler(data);
      }),
    flowControl: {
      pause: () => {
        pauseCalls++;
        raw.flowControl!.pause();
      },
      resume: () => raw.flowControl!.resume(),
    },
  };
  let exitAtMs = 0;
  const exited = new Promise<{ readonly exitCode: number; readonly signal?: number }>((resolve) => {
    raw.onExit((exit) => {
      exitAtMs = performance.now();
      resolve(exit);
    });
  });
  const terminal = attachPtyTerminal(ptySize, pty, (data, terminal) => {
    renderBatches++;
    const bytes = Buffer.byteLength(data);
    queuedBytes -= bytes;
    renderedBytes += bytes;
    observeFrame(data, terminal);
  });
  const timeout = setTimeout(() => raw.kill("SIGKILL"), 120_000);
  try {
    const { exitCode, signal } = await exited;
    await terminal.settled();
    const childExitToRenderMs = Math.round(performance.now() - exitAtMs);
    if (
      exitCode !== 0 ||
      signal ||
      renderedBytes !== expectedBytes ||
      !terminal.snapshot().text.includes(marker)
    ) {
      throw new Error(
        `Session ${sessionIndex}: exit=${exitCode}, signal=${signal}, rendered=${renderedBytes}/${expectedBytes} bytes`,
      );
    }
    return { maxQueuedBytes, pauseCalls, childExitToRenderMs, chunks, renderBatches };
  } finally {
    clearTimeout(timeout);
    terminal.dispose();
  }
}
