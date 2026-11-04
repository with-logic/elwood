/** The default capture setup deadline reaches the real process boundary (PRD §9.2, C-PERF-05). */
import { execFile } from "node:child_process";
import { expect, test, vi } from "vitest";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

test("C-PERF-05 capture setup without an override gives mkfifo the 60-second force-kill bound", async () => {
  // The preload loads the production runner; load capture afresh after this file's process mock.
  vi.resetModules();
  const { NamedPipeCapture, probeOutputSetupTimeoutMs } = await import(
    "../../src/runtime/probe/named-pipes.ts"
  );
  const capture = await NamedPipeCapture.create();
  try {
    expect(probeOutputSetupTimeoutMs).toBe(60_000);
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/mkfifo",
      expect.any(Array),
      { timeout: probeOutputSetupTimeoutMs, killSignal: "SIGKILL" },
      expect.any(Function),
    );
  } finally {
    capture.release();
  }
});
