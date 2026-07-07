/**
 * Codex session resume entry point built on the shared start path.
 * Implements PRD §5.6, §9.3, and C-API-16.
 */

import { elwoodError } from "../core/errors.ts";
import {
  defaultStateDir,
  readSessionRecord,
  upsertSessionWarning,
  writeSessionRecord,
} from "../state/store.ts";
import * as preflight from "./preflight.ts";
import { startCodexFromRecord } from "./session.ts";
import type { CodexSession, ResumeCodexOptions } from "./session-types.ts";

export async function resumeCodex(options: ResumeCodexOptions): Promise<CodexSession> {
  const stateDir = options.stateDir ?? defaultStateDir(options.cwd ?? process.cwd());
  const record = readSessionRecord(stateDir, options.elwoodSessionId);
  if (record.adapter !== "codex")
    throw elwoodError("adapter_mismatch", "Cannot resume a non-Codex session as Codex.");
  if (!record.codex.resumeId)
    throw elwoodError("resume_unavailable", "Cannot resume Codex without a Codex session id.");
  const warning = preflight.preflightCodex(
    options.strictVersionCheck ?? false,
    options.autoupdate ?? false,
  );
  const checkedRecord =
    warning === undefined
      ? record
      : upsertSessionWarning(record, { elwoodSessionId: record.elwoodSessionId, ...warning })
          .record;
  const size = options.initialSize ?? checkedRecord.terminalSize;
  const resumedRecord =
    options.initialSize === undefined
      ? checkedRecord
      : { ...checkedRecord, terminalSize: options.initialSize };
  writeSessionRecord(resumedRecord);
  return await startCodexFromRecord(resumedRecord, {
    cwd: options.cwd ?? record.cwd,
    stateDir,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(size === undefined ? {} : { initialSize: size }),
    ...(options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs }),
    ...(options.autotrust === undefined ? {} : { autotrust: options.autotrust }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
    ...(options.strictVersionCheck === undefined
      ? {}
      : { strictVersionCheck: options.strictVersionCheck }),
  });
}
