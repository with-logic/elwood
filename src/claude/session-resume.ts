/**
 * Claude session resume entry point built on the shared start path.
 * Implements PRD §5.2, §9.3, and C-API-16.
 */

import { elwoodError } from "../core/errors.ts";
import type { ClaudeSession, ResumeClaudeOptions } from "../core/types.ts";
import {
  claudeLaunchPosture,
  effectivePosture,
  withClaudeLaunch,
} from "../state/launch-posture.ts";
import {
  defaultStateDir,
  readSessionRecord,
  upsertSessionWarning,
  writeSessionRecord,
} from "../state/store.ts";
import { preflightClaude } from "./preflight.ts";
import { startClaudeFromRecord } from "./session.ts";

export async function resumeClaude(options: ResumeClaudeOptions): Promise<ClaudeSession> {
  const stateDir = options.stateDir ?? defaultStateDir(options.cwd ?? process.cwd());
  const record = readSessionRecord(stateDir, options.elwoodSessionId);
  if (record.adapter !== "claude") {
    throw elwoodError("adapter_mismatch", "Cannot resume a non-Claude session as Claude.");
  }
  if (!record.claude.resumeId) {
    throw elwoodError("resume_unavailable", "Cannot resume Claude without a Claude session id.");
  }
  const warning = preflightClaude(options.strictVersionCheck ?? false, options.autoupdate ?? false);
  const checkedRecord =
    warning === undefined
      ? record
      : upsertSessionWarning(record, { elwoodSessionId: record.elwoodSessionId, ...warning })
          .record;
  const size = options.initialSize ?? checkedRecord.terminalSize;
  const sized =
    options.initialSize === undefined
      ? checkedRecord
      : { ...checkedRecord, terminalSize: options.initialSize };
  // Resume defaults to the posture this session launched with; explicit
  // options override field by field, and the effective posture is
  // re-persisted (C-API-32, C-STATE-13).
  const launch = effectivePosture(checkedRecord.claude.launch, claudeLaunchPosture(options));
  const resumedRecord = withClaudeLaunch(sized, launch);
  writeSessionRecord(resumedRecord);
  return await startClaudeFromRecord(resumedRecord, {
    cwd: options.cwd ?? record.cwd,
    stateDir,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(size === undefined ? {} : { initialSize: size }),
    ...(options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs }),
    ...(options.autotrust === undefined ? {} : { autotrust: options.autotrust }),
    ...launch,
    ...(options.strictVersionCheck === undefined
      ? {}
      : { strictVersionCheck: options.strictVersionCheck }),
  });
}
