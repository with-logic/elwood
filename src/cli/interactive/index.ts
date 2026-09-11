/**
 * `elwood interactive [id]`: resolve Elwood settings, then run the agent's own CLI in
 * the foreground with no PTY, bridge, automation, observation, or state writes.
 * Implements PRD §12A.9 and C-CLI-23.
 */

import { readPrivateSessionRecord } from "../../state/private-session.ts";
import type { SessionRecord } from "../../state/store.ts";
import type { ParsedInteractiveCommand } from "../command-types.ts";
import type { CliSignalSource } from "../lifecycle/index.ts";
import { finalizeRunRequest, resolveRunSettings } from "../request/index.ts";
import { usage } from "../request/values.ts";
import type { CliEnvironment, PromptStdin } from "../types.ts";
import { interactiveLaunch } from "./launch.ts";
import { type InteractiveSpawner, spawnInteractiveAgent } from "./spawn.ts";

export type InteractiveCommandContext = {
  readonly env: CliEnvironment;
  readonly invocationCwd: string;
  readonly homeDir: string;
  readonly stdin: PromptStdin;
  readonly stdoutIsTTY?: boolean;
  readonly signals: CliSignalSource;
};

export type InteractiveCommandDependencies = {
  readonly readRecord: (stateDir: string, id: string) => SessionRecord;
  readonly finalize: typeof finalizeRunRequest;
  readonly spawn: InteractiveSpawner;
};

const defaults: InteractiveCommandDependencies = {
  readRecord: readPrivateSessionRecord,
  finalize: finalizeRunRequest,
  spawn: spawnInteractiveAgent,
};

export async function runInteractiveCommand(
  parsed: ParsedInteractiveCommand,
  context: InteractiveCommandContext,
  dependencies: InteractiveCommandDependencies = defaults,
): Promise<number> {
  if (context.stdin.isTTY !== true || context.stdoutIsTTY !== true)
    throw usage("interactive requires terminal stdin and stdout.");
  const draft = await resolveRunSettings(parsed.run, context);
  const stored =
    parsed.id === undefined ? undefined : dependencies.readRecord(draft.stateDir, parsed.id);
  const request = await dependencies.finalize(
    draft,
    stored === undefined ? undefined : { agent: stored.adapter, cwd: stored.cwd },
  );
  const launch = interactiveLaunch(request, stored);
  // Ctrl-C belongs to the foreground agent exactly as in a direct launch; Elwood must
  // not exit (Node's default) or interrupt anything while the agent owns the terminal.
  const release = context.signals.onSigint(() => undefined);
  try {
    return await dependencies.spawn(launch);
  } finally {
    release();
  }
}
