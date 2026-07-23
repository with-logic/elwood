/**
 * Claude session resume entry point built on the shared start path.
 * Implements PRD §5.2, §9.3, and C-API-16.
 */

import { resolve } from "node:path";
import { elwoodError } from "../core/errors.ts";
import type { ResumeClaudeOptions } from "../core/types.ts";
import {
  claudeLaunchPosture,
  effectivePosture,
  withClaudeLaunch,
} from "../state/launch-posture.ts";
import { defaultStateDir, readSessionRecord } from "../state/store.ts";
import { preflightClaude } from "./preflight.ts";
import { startClaudeFromRecord } from "./session.ts";
import type { ClaudeSession } from "./session-interface.ts";

export async function resumeClaude(options: ResumeClaudeOptions): Promise<ClaudeSession> {
  // Resolve stateDir to ABSOLUTE ONCE, before any read or `await`: a relative path
  // re-resolved after a `process.chdir()` between the record read and the runtime-file
  // writes would read one session and write another's files (PRD §8.1). (C-STATE)
  const stateDir = resolve(options.stateDir ?? defaultStateDir(options.cwd ?? process.cwd()));
  const record = readSessionRecord(stateDir, options.elwoodSessionId);
  if (record.adapter !== "claude") {
    throw elwoodError("adapter_mismatch", "Cannot resume a non-Claude session as Claude.");
  }
  if (!record.claude.resumeId) {
    throw elwoodError("resume_unavailable", "Cannot resume Claude without a Claude session id.");
  }
  const warning = await preflightClaude(
    options.strictVersionCheck ?? false,
    options.autoupdate ?? false,
  );
  // Resume defaults to the posture this session launched with; explicit options
  // override field by field, and the effective posture is re-persisted (C-API-32,
  // C-STATE-13). Terminal size is not persisted: it falls back to options.initialSize.
  const launch = effectivePosture(record.claude.launch, claudeLaunchPosture(options));
  const resumedRecord = withClaudeLaunch(record, launch);
  return await startClaudeFromRecord(
    resumedRecord,
    stateDir,
    {
      cwd: options.cwd ?? record.cwd,
      stateDir,
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      ...(options.initialSize === undefined ? {} : { initialSize: options.initialSize }),
      ...(options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs }),
      ...(options.autotrust === undefined ? {} : { autotrust: options.autotrust }),
      ...launch,
      ...(options.strictVersionCheck === undefined
        ? {}
        : { strictVersionCheck: options.strictVersionCheck }),
    },
    true, // resumed: mark ready on the first composer marker, symmetric with Codex
    warning,
  );
}
