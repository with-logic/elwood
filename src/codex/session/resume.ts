/**
 * Codex session resume entry point built on the shared start path.
 * Implements PRD §5.6, §9.3, and C-API-16.
 */

import { elwoodError } from "../../core/errors.ts";
import { applyCodexHighTrust } from "../../core/high-trust.ts";
import {
  checkLaunchDirectory,
  recheckLaunchDirectoryOnFailure,
} from "../../runtime/session/launch-directory.ts";
import { canonicalStatePath } from "../../state/canonical-path.ts";
import { reserveLaunchOwnership } from "../../state/launch-ownership.ts";
import {
  codexLaunchPosture,
  effectivePosture,
  withCodexLaunch,
} from "../../state/launch-posture.ts";
import { defaultStateDir, readSessionRecord, sessionDir } from "../../state/store.ts";
import * as preflight from "../preflight.ts";
import { startCodexFromRecord } from "./index.ts";
import type { CodexSessionApi, ResumeCodexOptions } from "./types.ts";

export async function resumeCodex(rawOptions: ResumeCodexOptions): Promise<CodexSessionApi> {
  // `highTrust` expands to its explicit posture override (or rejects a conflicting
  // explicit one) before anything else, exactly as on start (C-API-54).
  const options = applyCodexHighTrust(rawOptions);
  // Resolve stateDir to ABSOLUTE ONCE, before any read/await, so a `process.chdir()`
  // between the record read and the runtime-file writes can't split them (§8.1).
  const stateDir = canonicalStatePath(
    options.stateDir ?? defaultStateDir(options.cwd ?? process.cwd()),
  );
  const record = readSessionRecord(stateDir, options.elwoodSessionId);
  if (record.adapter !== "codex")
    throw elwoodError("adapter_mismatch", "Cannot resume a non-Codex session as Codex.");
  if (!record.codex.resumeId)
    throw elwoodError("resume_unavailable", "Cannot resume Codex without a Codex session id.");
  // Reserved before the first `await`: a teardown already running must see this successor
  // before it decides which shared state to remove (C-API-20).
  const ownership = reserveLaunchOwnership(sessionDir(stateDir, record.elwoodSessionId));
  try {
    // Codex relaunches where the session started (`--cd`); `cwd` only locates the state.
    // It is checked before any probe; a probe that fails because it went or was replaced fails as that.
    const directory = await checkLaunchDirectory("codex", record.cwd);
    const warning = await recheckLaunchDirectoryOnFailure(directory, () =>
      preflight.preflightCodex(
        record.cwd,
        options.strictVersionCheck ?? false,
        options.autoupdate ?? false,
        directory.identity,
      ),
    );
    // Resume defaults to the posture this session launched with; explicit options
    // override field by field, and the effective posture is re-persisted (C-API-32,
    // C-STATE-13). Terminal size is not persisted: it falls back to options.initialSize.
    const launch = effectivePosture(record.codex.launch, codexLaunchPosture(options));
    const resumedRecord = withCodexLaunch(record, launch);
    const session = await recheckLaunchDirectoryOnFailure(directory, () =>
      startCodexFromRecord(
        resumedRecord,
        stateDir,
        {
          cwd: record.cwd, // where Codex relaunches; `options.cwd` only located the state
          launchDirectory: directory,
          stateDir,
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          ...(options.initialSize === undefined ? {} : { initialSize: options.initialSize }),
          ...(options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs }),
          ...(options.autotrust === undefined ? {} : { autotrust: options.autotrust }),
          // Reasoning effort is NOT persisted posture — re-supply it per resume (C-CODEX-21).
          ...(options.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: options.reasoningEffort }),
          ...launch,
          ...(options.strictVersionCheck === undefined
            ? {}
            : { strictVersionCheck: options.strictVersionCheck }),
        },
        true, // resumed: mark ready on the first composer marker, not the 10s deadline
        warning,
        ownership,
      ),
    );
    return session;
  } catch (error) {
    ownership.rollback();
    throw error;
  }
}
