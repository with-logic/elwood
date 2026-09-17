/** A retained reaper keeps process liveness only, never captured output (PRD §9.2, C-PERF-03). */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import { runProbe, setProbeTimeoutMsForTests } from "../../src/runtime/probe.ts";

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
  setProbeTimeoutMsForTests(200);
  const result = await runProbe(process.execPath, [
    "-e",
    'process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000);',
  ]);
  const group = result.error?.cleanupProcessGroup;
  try {
    expect(result.error).toMatchObject({ code: "ETIMEDOUT", cleanupErrorCode: "ETIMEDOUT" });
    expect(result.stdout).toHaveLength(4096);
    expect(captured).toBeDefined();
    await expect
      .poll(() => {
        collectGarbage();
        // A boolean, so the poll itself never holds the buffer across a collection.
        return captured?.deref() === undefined;
      })
      .toBe(true);
  } finally {
    if (group !== undefined) kill(-group, "SIGKILL");
  }
});
