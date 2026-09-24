/** CodexSessionApi entry points: preflight, record creation, and socket-home-guarded start. Implements PRD §5.5, §5.6, §5.7, §7A, §8, §9. */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { checkedInputBytes } from "../../core/control-queue/budget.ts";
import { applyCodexHighTrust } from "../../core/high-trust.ts";
import { queuePersonaMessage } from "../../core/persona.ts";
import { codexReasoningEfforts, validateReasoningEffort } from "../../core/reasoning-effort.ts";
import { withSocketHomeCleanup } from "../../runtime/startup/cleanup.ts";
import { canonicalStatePath } from "../../state/canonical-path.ts";
import { safeSessionDir } from "../../state/files.ts";
import type { LaunchReservation } from "../../state/launch-ownership.ts";
import { codexLaunchPosture, withCodexLaunch } from "../../state/launch-posture.ts";
import { sessionRuntime } from "../../state/runtime-paths.ts";
import { removeOwnSocketFile } from "../../state/socket-home.ts";
import { withLaunchOwnership } from "../../state/startup-ownership.ts";
import {
  createSessionRecord,
  defaultStateDir,
  prepareStateDir,
  type SessionRecord,
} from "../../state/store.ts";
import * as preflight from "../preflight.ts";
import { buildCodexSession } from "./build.ts";
import type { CodexSessionApi, StartCodexOptions } from "./types.ts";

export {
  resetCodexSessionSeamsForTests,
  setCodexHookBridgeFactoryForTests,
} from "./bridge.ts";

/**
 * @deprecated Prefer the `CodexSession` class (`new CodexSession(options)`), which starts
 * lazily and exposes both `send`/`stream` and this full control surface. `startCodex`
 * remains the low-level eager factory and is used internally; it will be removed once the
 * sole consumer migrates.
 */
export function startCodex(rawOptions: StartCodexOptions): Promise<CodexSessionApi> {
  return startCodexWithId(rawOptions, randomUUID());
}

/** Internal deterministic-identity start used by owners that must clean failed launch state. */
export async function startCodexWithId(
  rawOptions: StartCodexOptions,
  elwoodSessionId: string,
): Promise<CodexSessionApi> {
  // Resolve BOTH cwd and stateDir to ABSOLUTE before the preflight `await`: a relative
  // path resolved after the await could point elsewhere if the caller's (or preflight's)
  // process.cwd() changed during it, splitting where state is written from where the CLI
  // launches (§8.1, §8.2). Thread the resolved cwd everywhere so the record, launch, and
  // PTY spawn all agree. `highTrust` expands to its concrete posture (or rejects a
  // conflicting explicit one) HERE, before preflight, so the persisted record and the
  // launch command both carry the expanded posture (C-API-54).
  const options = applyCodexHighTrust({ ...rawOptions, cwd: resolve(rawOptions.cwd) });
  checkedInputBytes(options.persona ?? "");
  const stateDir = canonicalStatePath(options.stateDir ?? defaultStateDir(options.cwd));
  const warning = await preflight.preflightCodex(
    options.strictVersionCheck ?? false,
    options.autoupdate ?? false,
  );
  prepareStateDir(stateDir, { gitignore: options.stateDir === undefined });
  const createdRecord = createSessionRecord({
    cwd: options.cwd,
    id: elwoodSessionId,
    adapter: "codex",
  });
  const record = withCodexLaunch(createdRecord, codexLaunchPosture(options));
  const session = await startCodexFromRecord(record, stateDir, options, false, warning);
  return queuePersonaMessage(session, options.persona, session.closing.signal);
}

export function startCodexFromRecord(
  record: SessionRecord,
  stateDir: string,
  options: StartCodexOptions,
  resumed: boolean,
  preflightWarning: preflight.CodexPreflightWarning | undefined,
  ownership?: LaunchReservation,
) {
  // Validate the effort enum before any spawn (C-CODEX-21): both start and resume funnel
  // through here. Codex validates server-side (a bad value fails at the first turn), so
  // this turns a deferred provider error into a fast, clear start-time rejection.
  validateReasoningEffort(
    options.reasoningEffort,
    codexReasoningEfforts,
    "codex_invalid_reasoning_effort",
  );
  // `sessionRuntime` ensures the session's STABLE out-of-tree home and reserves a FRESH
  // per-launch socket PATH inside it; the socket is bound later, by `bridge.start()`
  // (after the state/runtime files are written). Wrap the WHOLE build so ANY failure
  // before the session takes ownership removes THIS launch's own socket file — never the
  // shared home, which a concurrent launch may own (§9.1). On success ownership transfers
  // to the returned session, whose teardown removes the whole home via removeSessionFiles.
  return withLaunchOwnership(
    safeSessionDir(stateDir, record.elwoodSessionId),
    ownership,
    (owner, activate) => {
      const runtime = sessionRuntime(
        {
          stateDir,
          elwoodSessionId: record.elwoodSessionId,
          adapter: "codex",
        },
        owner,
      );
      return withSocketHomeCleanup(
        () => removeOwnSocketFile(runtime.socketPath),
        () =>
          buildCodexSession({
            record,
            stateDir,
            runtime,
            options,
            resumed,
            preflightWarning,
            activate,
          }),
      );
    },
  );
}
