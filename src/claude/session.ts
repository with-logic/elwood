/** ClaudeSessionApi entry points: preflight, record creation, and socket-home-guarded start. Implements PRD §5, §6, §8, §9. */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { queuePersonaMessage } from "../core/persona.ts";
import { claudeReasoningEfforts, validateReasoningEffort } from "../core/reasoning-effort.ts";
import type { StartClaudeOptions } from "../core/types.ts";
import { withSocketHomeCleanup } from "../runtime/startup-cleanup.ts";
import { claudeLaunchPosture, withClaudeLaunch } from "../state/launch-posture.ts";
import { sessionRuntime } from "../state/runtime-paths.ts";
import { removeOwnSocketFile } from "../state/socket-home.ts";
import type { SessionRecord } from "../state/store.ts";
import { createSessionRecord, defaultStateDir, prepareStateDir } from "../state/store.ts";
import type { ClaudePreflightWarning } from "./preflight.ts";
import { preflightClaude } from "./preflight.ts";
import {
  resetClaudeHookBridgeFactoryForTests,
  setHookBridgeFactoryForTests,
} from "./session-bridge.ts";
import { buildClaudeSession } from "./session-build.ts";
import type { ClaudeSessionApi } from "./session-interface.ts";

export {
  resetClaudeHookBridgeFactoryForTests as resetClaudeSessionSeamsForTests,
  setHookBridgeFactoryForTests,
};

/**
 * @deprecated Prefer the `ClaudeSession` class (`new ClaudeSession(options)`), which starts
 * lazily and exposes both `send`/`stream` and this full control surface. `startClaude`
 * remains the low-level eager factory and is used internally; it will be removed once the
 * sole consumer migrates.
 */
export async function startClaude(rawOptions: StartClaudeOptions): Promise<ClaudeSessionApi> {
  // Resolve BOTH cwd and stateDir to ABSOLUTE before the preflight `await`: a relative
  // path resolved after the await could point elsewhere if the caller's (or preflight's)
  // process.cwd() changed during it, splitting where state is written from where the CLI
  // launches (§8.1, §8.2). Thread the resolved cwd everywhere so the record, launch, and
  // PTY spawn all agree.
  const options = { ...rawOptions, cwd: resolve(rawOptions.cwd) };
  const stateDir = resolve(options.stateDir ?? defaultStateDir(options.cwd));
  const strict = options.strictVersionCheck ?? false;
  const warning = await preflightClaude(strict, options.autoupdate ?? false);
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
  // Validate the effort enum before any spawn (C-CLAUDE-20): both start and resume
  // funnel through here, so a bad value fails fast at the single chokepoint.
  validateReasoningEffort(
    options.reasoningEffort,
    claudeReasoningEfforts,
    "claude_invalid_reasoning_effort",
  );
  // `sessionRuntime` ensures the session's STABLE out-of-tree home and reserves a FRESH
  // per-launch socket PATH inside it; the socket is bound later, by `bridge.start()`
  // (after the state/runtime files are written). Wrap the WHOLE build so ANY failure
  // before the session takes ownership removes THIS launch's own socket file — never the
  // shared home, which a concurrent launch may own (§9.1). On success ownership transfers
  // to the returned session, whose teardown removes the whole home via removeSessionFiles.
  const runtime = sessionRuntime({
    stateDir,
    elwoodSessionId: record.elwoodSessionId,
    adapter: "claude",
  });
  return withSocketHomeCleanup(
    () => removeOwnSocketFile(runtime.socketPath),
    () => buildClaudeSession({ record, stateDir, runtime, options, resumed, preflightWarning }),
  );
}
