/** Unbound probes do not allocate or scan directory-refusal markers (PRD §9.2, C-PERF-03). */
import { expect, test, vi } from "vitest";
import { directoryGuardExitCode } from "../../src/core/checked-command.ts";
import { checkedProbeCommand, ProbeDirectoryRefusal } from "../../src/runtime/probe/directory.ts";
import { StreamMarkerWatcher } from "../../src/runtime/stream-marker.ts";

test("C-PERF-03 an unbound probe neither allocates marker buffers nor copies profile chunks", () => {
  const chunk = Buffer.alloc(1_000_000, "x");
  const from = vi.spyOn(Buffer, "from");
  const concat = vi.spyOn(Buffer, "concat");
  const feed = vi.spyOn(StreamMarkerWatcher.prototype, "feed");
  let calls: readonly number[];
  let result: ReturnType<ProbeDirectoryRefusal["result"]>;
  try {
    const refusal = new ProbeDirectoryRefusal({});
    refusal.feed("stdout", chunk);
    refusal.feed("control", chunk);
    result = refusal.result(directoryGuardExitCode);
    calls = [from.mock.calls.length, concat.mock.calls.length, feed.mock.calls.length];
  } finally {
    vi.restoreAllMocks();
  }
  expect(calls).toEqual([0, 0, 0]);
  expect(result).toBeUndefined();
});

test("C-API-61 a private marker without the guard status does not establish refusal", () => {
  const options = { cwd: "/unused", directoryIdentity: { dev: 1n, ino: 2n } };
  const script = checkedProbeCommand("/bin/sh", ["-c", "exit 0"], options).args.join("\n");
  const marker = script.match(/elwood-probe-directory-refused-[0-9a-f]{16}/)?.[0];
  expect(marker).toBeDefined();
  const refusal = new ProbeDirectoryRefusal(options);
  refusal.feed("stdout", Buffer.from(`${marker}\n`));
  expect(refusal.result(0)).toBeUndefined();
  expect(refusal.result(directoryGuardExitCode)).toMatchObject({
    error: { origin: "probe_setup" },
  });
});
