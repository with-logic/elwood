/**
 * Opens update probes only after their process-group identity is durable.
 * Implements PRD §9.2 / C-PERF-04; command and arguments remain positional data.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { currentProbeRegistration } from "./update/probe-registration.ts";

export type SpawnedProbe = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly open: Promise<void>;
};

export function spawnProbe(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
): SpawnedProbe {
  const registration = currentProbeRegistration();
  if (registration === undefined) {
    return { child: spawn(command, [...args], { detached: true }), open: Promise.resolve() };
  }
  // A closed stdin or failed read exits without exec. Nothing supplied by the
  // caller is interpolated into shell source, including the executable path.
  const child = spawn(
    "/bin/sh",
    ["-c", 'IFS= read -r gate || exit; exec "$@"', "elwood-probe", command, ...args],
    { detached: true },
  );
  const open = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.once("spawn", () => {
      void registration
        .register(child.pid!, signal)
        .then(async () => {
          if (signal.aborted) return;
          await pipeline(Readable.from(["\n"]), child.stdin);
        })
        .then(resolve, reject);
    });
  });
  return { child, open };
}
