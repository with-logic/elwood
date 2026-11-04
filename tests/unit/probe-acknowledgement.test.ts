/** A closed supervisor acknowledgement cannot replace its probe result (PRD §9.2, C-PERF-03). */
import type { SpawnOptions } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { shellQuote } from "../../src/core/shell.ts";
import { tempDir } from "../helpers/tmp.ts";

const peer = vi.hoisted(() => ({
  errors: [] as unknown[],
  supervised: 0,
  release: "",
  exited: Promise.resolve(),
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
      const rewritten = [...args];
      const supervised = args[3] === "elwood-probe-supervisor";
      if (supervised) peer.supervised++;
      // A real supervisor closes its acknowledgement reader while still running the command.
      if (supervised)
        rewritten[2] = `exec 5<&-; ${args[2]?.replace("IFS= read -r elwood_ack <&5;", `while [ ! -f ${shellQuote(peer.release)} ]; do /bin/sleep 0.01; done;`)}`;
      const child = actual.spawn(command, rewritten, options);
      if (supervised) {
        peer.exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        const socket = child.stdio.at(5) as Socket;
        // Retain the local write half after peer EOF to exercise the release/close race.
        socket.allowHalfOpen = true;
        const emit = socket.emit.bind(socket);
        // Observe without installing an error listener that could hide the missing owner.
        vi.spyOn(socket, "emit").mockImplementation((event, ...values) => {
          if (event === "error") peer.errors.push(values[0]);
          return emit(event, ...values);
        });
      }
      return child;
    },
  };
});
afterEach(() => vi.restoreAllMocks());

test("C-PERF-03 release after a real closed acknowledgement peer preserves status and output", async () => {
  vi.resetModules();
  peer.errors.length = 0;
  peer.supervised = 0;
  peer.release = join(tempDir("elwood-closed-ack-"), "release");
  const { runProbe } = await import("../../src/runtime/probe/index.ts");
  const { probeShellCommand, shellQuote } = await import("../../src/runtime/shell.ts");
  const args = probeShellCommand(`/bin/sh -c ${shellQuote("printf ok; printf err >&2; exit 7")}`);
  try {
    const result = await runProbe("/bin/sh", ["-c", args[3]]);
    expect(result).toEqual({ status: 7, stdout: "ok", stderr: "err" });
    expect(peer.supervised).toBe(1);
    await vi.waitFor(() =>
      expect(peer.errors).toContainEqual(expect.objectContaining({ code: "EPIPE" })),
    );
    expect(result).toEqual({ status: 7, stdout: "ok", stderr: "err" });
  } finally {
    writeFileSync(peer.release, "");
    await peer.exited;
  }
});
