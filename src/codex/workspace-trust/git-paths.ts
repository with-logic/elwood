/** Inspect canonical Git metadata paths off the host event loop (PRD §5.5). */
import { realpath } from "node:fs";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import { errnoCode } from "../../core/errors.ts";

const realpathNative = promisify(realpath.native);

export async function canonicalGitPath(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return await realpathNative(path);
}

/** Return undefined on ENOENT. Propagate other errors. */
export async function lstatGitPath(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    return await lstat(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}
