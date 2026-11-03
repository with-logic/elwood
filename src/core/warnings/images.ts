/** Image attachment diagnostics (PRD §5.3, §5.7, C-API-46). */

import type { ErrnoToken } from "../errors.ts";
import type { unknownErrorToken } from "./reasons.ts";

/** Why a pasted image's copy could not be removed: its errno token, else `UnknownError`. */
export type ImageCopyErrorCode = ErrnoToken | typeof unknownErrorToken;

/**
 * Codex-only: once the session's CLI exited, Elwood could not remove a copy Codex saved of an
 * image pasted into it, so the copy stays in the temp directory for the OS to reap. One per
 * session at most, emitted before `terminal:exit`. Content-free: the first failure's errno
 * token (such as `EPERM`), or `UnknownError`, and never a path or image data.
 */
export type ImageCopyRemovalFailedWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "codex";
  readonly source: "lifecycle";
  readonly code: "image_copy_removal_failed";
  readonly severity: "warning";
  readonly message: string;
  readonly errorCode: ImageCopyErrorCode;
  readonly raw: string;
};
