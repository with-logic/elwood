/** Bounded probes, owned cleanup and home-guard reporting (PRD §9.2/§12, C-PERF-03/05/07, C-E2E-24). */

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { toError } from "../../core/errors.ts";
import type { CommandOptions, CommandResult } from "../seams.ts";
import { type ProbeCapture, probeCapture } from "./capture.ts";
import { NamedPipeCapture } from "./named-pipes.ts";
import { mapError, outputUnavailable } from "./results.ts";
import { runCapturedProbe } from "./run.ts";
import { withProbeSlot } from "./slots.ts";
import { announcesStart } from "./start.ts";

/** The probe command's own default bound, from the shell's start line (C-PERF-03). */
export const probeCommandTimeoutMs = 15_000;
/**
 * The login shell's default bound, from spawn to its start line (C-PERF-05). Loading the
 * user's interactive profile took 7-19 s at 16 concurrent probes on a loaded host.
 */
export const probeLaunchTimeoutMs = 60_000;
let commandTimeoutMs = probeCommandTimeoutMs;
let launchTimeoutMs = probeLaunchTimeoutMs;

/** Overrides each phase's bound. A direct test command never writes the start line, so it hits `launchMs`. */
export function setProbeTimeoutsForTests(bounds: {
  readonly commandMs: number;
  readonly launchMs: number;
}): void {
  commandTimeoutMs = bounds.commandMs;
  launchTimeoutMs = bounds.launchMs;
}

export function resetProbeTimeoutsForTests(): void {
  commandTimeoutMs = probeCommandTimeoutMs;
  launchTimeoutMs = probeLaunchTimeoutMs;
}

/** Runs one probe once a probe slot is free; its bounds start when it spawns (C-PERF-07). */
export function runProbe(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return withProbeSlot(() => spawnProbe(command, args, options));
}

async function spawnProbe(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  let capture: ProbeCapture;
  try {
    capture = await probeCapture(args);
  } catch (error) {
    return outputUnavailable(error);
  }
  try {
    // Keep native shell-path diagnostics: a supervisor’s status cannot carry errno fields.
    if ((capture instanceof NamedPipeCapture || announcesStart(args)) && command.includes("/"))
      await access(resolve(options.cwd ?? process.cwd(), command), constants.X_OK);
  } catch (error) {
    capture.release();
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: mapError(toError(error)),
    };
  }
  return runCapturedProbe(command, args, capture, options, {
    launch: () => launchTimeoutMs,
    command: () => commandTimeoutMs,
  });
}
