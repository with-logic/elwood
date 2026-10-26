/**
 * Claude session resume entry point built on the shared start path.
 * Implements PRD §5.2, §9.3, and C-API-16.
 */

import { elwoodError } from "../../core/errors.ts";
import { applyClaudeHighTrust } from "../../core/high-trust.ts";
import type { ResumeClaudeOptions } from "../../core/types.ts";
import {
  recheckLaunchDirectoryOnFailure,
  resolveLaunchDirectory,
} from "../../runtime/session/launch-directory.ts";
import { canonicalStatePath } from "../../state/canonical-path.ts";
import { reserveLaunchOwnership } from "../../state/launch-ownership.ts";
import {
  claudeLaunchPosture,
  effectivePosture,
  withClaudeLaunch,
} from "../../state/launch-posture.ts";
import { defaultStateDir, readSessionRecord, sessionDir } from "../../state/store.ts";
import { preflightClaude } from "../preflight.ts";
import { startClaudeFromRecord } from "./index.ts";
import type { ClaudeSessionApi } from "./interface.ts";

export async function resumeClaude(rawOptions: ResumeClaudeOptions): Promise<ClaudeSessionApi> {
  // `highTrust` expands to its explicit posture override (or rejects a conflicting
  // explicit one) before anything else, exactly as on start (C-API-54).
  const options = applyClaudeHighTrust(rawOptions);
  // The given `cwd`, resolved once, before any read or `await`, so the directory checked is the
  // one launched in even if `process.cwd()` changes.
  const given =
    options.cwd === undefined ? undefined : resolveLaunchDirectory("claude", options.cwd);
  // Resolve stateDir to ABSOLUTE ONCE, before any read or `await`: a relative path
  // re-resolved after a `process.chdir()` between the record read and the runtime-file
  // writes would read one session and write another's files (PRD §8.1). (C-STATE)
  const stateDir = canonicalStatePath(options.stateDir ?? defaultStateDir(given ?? process.cwd()));
  const record = readSessionRecord(stateDir, options.elwoodSessionId);
  if (record.adapter !== "claude") {
    throw elwoodError("adapter_mismatch", "Cannot resume a non-Claude session as Claude.");
  }
  if (!record.claude.resumeId) {
    throw elwoodError("resume_unavailable", "Cannot resume Claude without a Claude session id.");
  }
  // Claude relaunches in the given `cwd`, else where the session started.
  const cwd = given ?? resolveLaunchDirectory("claude", record.cwd);
  // Reserved before the first `await`: a teardown already running must see this successor
  // before it decides which shared state to remove (C-API-20).
  const ownership = reserveLaunchOwnership(sessionDir(stateDir, record.elwoodSessionId));
  try {
    // `cwd` is checked before any probe; a probe that fails because it went or was replaced fails as that.
    const warning = await recheckLaunchDirectoryOnFailure("claude", cwd, () =>
      preflightClaude(cwd, options.strictVersionCheck ?? false, options.autoupdate ?? false),
    );
    // Resume defaults to the posture this session launched with; explicit options
    // override field by field, and the effective posture is re-persisted (C-API-32,
    // C-STATE-13). Terminal size is not persisted: it falls back to options.initialSize.
    const launch = effectivePosture(record.claude.launch, claudeLaunchPosture(options));
    const resumedRecord = withClaudeLaunch(record, launch);
    const session = await recheckLaunchDirectoryOnFailure("claude", cwd, () =>
      startClaudeFromRecord(
        resumedRecord,
        stateDir,
        {
          cwd,
          stateDir,
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          ...(options.initialSize === undefined ? {} : { initialSize: options.initialSize }),
          ...(options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs }),
          ...(options.autotrust === undefined ? {} : { autotrust: options.autotrust }),
          // Reasoning effort is NOT persisted posture — re-supply it per resume (C-CLAUDE-20).
          ...(options.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: options.reasoningEffort }),
          ...launch,
          ...(options.strictVersionCheck === undefined
            ? {}
            : { strictVersionCheck: options.strictVersionCheck }),
        },
        true, // resumed: mark ready on the first composer marker, symmetric with Codex
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
