/**
 * A retained reaper keeps process liveness only, never captured output (PRD §9.2,
 * C-PERF-03). The reaper holds the child for as long as its group runs, so the capture is
 * only collectable because `settle` releases the buffers before the reaper takes over.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import { runProbe } from "../../src/runtime/probe.ts";
import type { CommandResult } from "../../src/runtime/seams.ts";

const kill = process.kill.bind(process);
const { concat } = Buffer;
afterEach(() => {
  Buffer.concat = concat;
  vi.restoreAllMocks();
});

test("C-PERF-03 an unresolved probe's reaper does not retain its captured output", async () => {
  setFlagsFromString("--expose-gc");
  const collectGarbage = runInNewContext("gc") as () => void;
  let captured: WeakRef<Uint8Array> | undefined;
  // Observes the capture without holding it; a spy would retain its arguments.
  Buffer.concat = (chunks, ...rest) => {
    const [first] = chunks;
    if (first !== undefined) captured ??= new WeakRef(first);
    return concat(chunks, ...rest);
  };
  // Signals are swallowed, so the group stays unresolved and its reaper is retained.
  vi.spyOn(process, "kill").mockReturnValue(true);
  // Aborted by its own output rather than by a timeout, so a slow child start under load
  // cannot leave the capture empty.
  const result = await runProbe(process.execPath, [
    "-e",
    'process.stdout.write("x".repeat(2_000_000)); setInterval(() => {}, 1000);',
  ]);
  const group = result.error?.cleanupProcessGroupId;
  try {
    expect(result.error).toMatchObject({ code: "E2BIG", cleanupErrorCode: "ETIMEDOUT" });
    expect(result.stdout).toHaveLength(1_000_000);
    expect(captured).toBeDefined();
    await expect
      .poll(() => {
        collectGarbage();
        // A boolean, so the poll itself never holds the buffer across a collection.
        return captured?.deref() === undefined;
      })
      .toBe(true);
  } finally {
    // The flooding child usually dies of its broken pipe first; a failed assertion above
    // must not be masked by this cleanup finding the group already gone.
    try {
      kill(-(group as number), "SIGKILL");
    } catch {}
  }
});

/**
 * Releasing the chunks is not enough on its own. The stream and exit listeners stay attached
 * to the child, each closing over `settle` and through it the promise resolver and the
 * decoded strings; a retained reaper holds the child, so that whole graph — the settled
 * result included — outlives delivery unless the listeners are detached.
 */
test("C-PERF-03 a retained reaper does not keep the settled probe result reachable", async () => {
  setFlagsFromString("--expose-gc");
  const collectGarbage = runInNewContext("gc") as () => void;
  // Signals are swallowed, so the group stays unresolved and its reaper is retained.
  vi.spyOn(process, "kill").mockReturnValue(true);
  let result: CommandResult | undefined = await runProbe(process.execPath, [
    "-e",
    'process.stdout.write("x".repeat(2_000_000)); setInterval(() => {}, 1000);',
  ]);
  const group = result.error?.cleanupProcessGroupId;
  // Held across the collection so the assertion can still name the group, unlike the result.
  const settled = new WeakRef(result);
  try {
    expect(result.stdout).toHaveLength(1_000_000);
    // The caller drops its reference; nothing the probe left behind may keep it alive.
    result = undefined;
    await expect
      .poll(() => {
        collectGarbage();
        return settled.deref() === undefined;
      })
      .toBe(true);
  } finally {
    try {
      kill(-(group as number), "SIGKILL");
    } catch {}
  }
});
