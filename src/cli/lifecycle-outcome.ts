/**
 * Pure cleanup-policy and execution-error classification for the CLI lifecycle owner.
 * Implements PRD §12A.2/§12A.5 and C-CLI-08/C-CLI-17.
 */

import { ElwoodError } from "../core/errors.ts";
import type { EffectiveRunRequest } from "./types.ts";

export type CliFailure = {
  readonly code: string;
  readonly message: string;
  readonly exitCode: 1 | 124 | 130;
};

export function cleanupAction(request: EffectiveRunRequest): "preserve" | "teardown" {
  return request.resume === undefined
    ? request.keep
      ? "preserve"
      : "teardown"
    : request.ephemeral
      ? "teardown"
      : "preserve";
}

export function executionFailure(error: unknown): CliFailure {
  if (error instanceof ElwoodError)
    return { code: error.code, message: error.message, exitCode: 1 };
  return { code: "runtime_error", message: "Agent execution failed.", exitCode: 1 };
}
