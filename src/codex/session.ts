/** CodexSession entry points: preflight, record creation, and socket-home-guarded start. Implements PRD §5.5, §5.6, §5.7, §7A, §8, §9. */
import { randomUUID } from "node:crypto";
import { queuePersonaMessage } from "../core/persona.ts";
import { withSocketHomeCleanup } from "../runtime/startup-cleanup.ts";
import { codexLaunchPosture, withCodexLaunch } from "../state/launch-posture.ts";
import { sessionRuntime } from "../state/runtime-paths.ts";
import { removeSocketHome } from "../state/socket-home.ts";
import {
  createSessionRecord,
  defaultStateDir,
  prepareStateDir,
  type SessionRecord,
} from "../state/store.ts";
import * as preflight from "./preflight.ts";
import { buildCodexSession } from "./session-build.ts";
import type { CodexSession, StartCodexOptions } from "./session-types.ts";

export {
  resetCodexSessionSeamsForTests,
  setCodexHookBridgeFactoryForTests,
} from "./session-bridge.ts";

export async function startCodex(options: StartCodexOptions): Promise<CodexSession> {
  const warning = await preflight.preflightCodex(
    options.strictVersionCheck ?? false,
    options.autoupdate ?? false,
  );
  const stateDir = options.stateDir ?? defaultStateDir(options.cwd);
  prepareStateDir(stateDir, { gitignore: options.stateDir === undefined });
  const createdRecord = createSessionRecord({
    cwd: options.cwd,
    id: randomUUID(),
    adapter: "codex",
  });
  const record = withCodexLaunch(createdRecord, codexLaunchPosture(options));
  const session = await startCodexFromRecord(record, stateDir, options, false, warning);
  return queuePersonaMessage(session, options.persona);
}

export function startCodexFromRecord(
  record: SessionRecord,
  stateDir: string,
  options: StartCodexOptions,
  resumed: boolean,
  preflightWarning: preflight.CodexPreflightWarning | undefined,
) {
  // The runtime mints a fresh out-of-tree socket home BEFORE any state/runtime write,
  // bridge start, or PTY start. Wrap the whole build so ANY failure before the session
  // takes ownership removes that `/tmp/elwood-*` dir (§9.1); on success ownership
  // transfers to the returned session (teardown removes it via removeSessionFiles).
  const runtime = sessionRuntime({
    stateDir,
    elwoodSessionId: record.elwoodSessionId,
    adapter: "codex",
  });
  return withSocketHomeCleanup(
    () => removeSocketHome(runtime.socketPath),
    () => buildCodexSession({ record, stateDir, runtime, options, resumed, preflightWarning }),
  );
}
