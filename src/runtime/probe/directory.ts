/** Preserve pinned probe-directory identity across queue/profile boundaries (C-API-61). */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  directoryGuardExitCode,
  wrapCommandWithDirectoryGuard,
} from "../../core/checked-command.ts";
import { sameDirectoryIdentity } from "../../core/directory-identity.ts";
import { toError } from "../../core/errors.ts";
import { probeCommandRefusedReason } from "../../core/probe-refusal.ts";
import type { CommandOptions, CommandResult } from "../seams.ts";
import { StreamMarkerWatcher } from "../stream-marker.ts";
import { mapError, outputUnavailable } from "./results.ts";
import { announcesStart, type ProbeStartChannel } from "./start.ts";

const refusalLine = `elwood-probe-directory-refused-${randomBytes(8).toString("hex")}`;
const refusalScript = `{ echo ${refusalLine} >&3; } 2>/dev/null || { echo ${refusalLine}; } 2>/dev/null || :; `;

/** Called inside the admitted probe slot, retaining the caller's original identity. */
export async function refusedProbeDirectory(
  options: CommandOptions,
): Promise<CommandResult | undefined> {
  if (options.directoryIdentity === undefined) return undefined;
  try {
    const observed = await stat(options.cwd, { bigint: true });
    if (sameDirectoryIdentity(observed, options.directoryIdentity)) return undefined;
  } catch (error) {
    return outputUnavailable(error);
  }
  return outputUnavailable(new Error(probeCommandRefusedReason));
}

/** Native configured-shell errors cannot be recovered from a supervisor's exit status. */
export async function nativeShellFailure(
  command: string,
  options: CommandOptions,
  supervised: boolean,
): Promise<CommandResult | undefined> {
  if (!(supervised && command.includes("/"))) return undefined;
  try {
    await access(resolve(options.cwd ?? process.cwd(), command), constants.X_OK);
    return undefined;
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: mapError(toError(error)),
    };
  }
}

/** Capture paths must be rewritten before wrapCommandWithDirectoryGuard quotes and embeds the login script. */
export function checkedProbeCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions,
) {
  return wrapCommandWithDirectoryGuard(
    command,
    args,
    options.cwd ?? process.cwd(),
    options.directoryIdentity,
    announcesStart(args),
    process.platform,
    refusalScript,
  );
}

/** Only the private signal plus guard status proves refusal; a profile exit alone does not. */
export class ProbeDirectoryRefusal {
  private readonly watchers: Readonly<Record<ProbeStartChannel, StreamMarkerWatcher>> | undefined;
  private readonly options: CommandOptions;
  constructor(options: CommandOptions) {
    this.options = options;
    this.watchers =
      options.directoryIdentity === undefined
        ? undefined
        : {
            control: new StreamMarkerWatcher(Buffer.from(`${refusalLine}\n`)),
            stdout: new StreamMarkerWatcher(Buffer.from(`${refusalLine}\n`)),
          };
  }

  feed(channel: ProbeStartChannel, chunk: Buffer): void {
    this.watchers?.[channel].feed(chunk);
  }

  result(status: number | null): CommandResult | undefined {
    const hasIdentity = this.options.directoryIdentity !== undefined;
    const hasGuardExitCode = status === directoryGuardExitCode;
    const sawRefusalMarker =
      this.watchers !== undefined && Object.values(this.watchers).some((watcher) => watcher.seen);
    if (!(hasIdentity && hasGuardExitCode && sawRefusalMarker)) return undefined;
    return outputUnavailable(new Error(probeCommandRefusedReason));
  }
}
