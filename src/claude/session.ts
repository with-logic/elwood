/** ClaudeSession entry points: preflight, record creation, and socket-home-guarded start. Implements PRD §5, §6, §8, §9. */
import { randomUUID } from "node:crypto";
import { queuePersonaMessage } from "../core/persona.ts";
import type { StartClaudeOptions } from "../core/types.ts";
import { withSocketHomeCleanup } from "../runtime/startup-cleanup.ts";
import { claudeLaunchPosture, withClaudeLaunch } from "../state/launch-posture.ts";
import { sessionRuntime } from "../state/runtime-paths.ts";
import { removeSocketHome } from "../state/socket-home.ts";
import type { SessionRecord } from "../state/store.ts";
import { createSessionRecord, defaultStateDir, prepareStateDir } from "../state/store.ts";
import type { ClaudePreflightWarning } from "./preflight.ts";
import { preflightClaude } from "./preflight.ts";
import {
  resetClaudeHookBridgeFactoryForTests,
  setHookBridgeFactoryForTests,
} from "./session-bridge.ts";
import { buildClaudeSession } from "./session-build.ts";
import type { ClaudeSession } from "./session-interface.ts";

export {
  resetClaudeHookBridgeFactoryForTests as resetClaudeSessionSeamsForTests,
  setHookBridgeFactoryForTests,
};

export async function startClaude(options: StartClaudeOptions): Promise<ClaudeSession> {
  const strict = options.strictVersionCheck ?? false;
  const warning = await preflightClaude(strict, options.autoupdate ?? false);
  const stateDir = options.stateDir ?? defaultStateDir(options.cwd);
  prepareStateDir(stateDir, { gitignore: options.stateDir === undefined });
  const createdRecord = createSessionRecord({ cwd: options.cwd, id: randomUUID() });
  const record = withClaudeLaunch(createdRecord, claudeLaunchPosture(options));
  const session = await startClaudeFromRecord(record, stateDir, options, false, warning);
  return queuePersonaMessage(session, options.persona);
}

export function startClaudeFromRecord(
  record: SessionRecord,
  stateDir: string,
  options: StartClaudeOptions,
  resumed: boolean,
  preflightWarning: ClaudePreflightWarning | undefined,
) {
  // The runtime mints a fresh out-of-tree socket home BEFORE any state/runtime write,
  // bridge start, or PTY start. Wrap the whole build so ANY failure before the session
  // takes ownership removes that `/tmp/elwood-*` dir (§9.1); on success ownership
  // transfers to the returned session (teardown removes it via removeSessionFiles).
  const runtime = sessionRuntime({
    stateDir,
    elwoodSessionId: record.elwoodSessionId,
    adapter: "claude",
  });
  return withSocketHomeCleanup(
    () => removeSocketHome(runtime.socketPath),
    () => buildClaudeSession({ record, stateDir, runtime, options, resumed, preflightWarning }),
  );
}
