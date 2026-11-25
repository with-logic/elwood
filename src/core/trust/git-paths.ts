/** Resolve Claude and Codex trust paths asynchronously (PRD §5.1, §5.5). */
import { realpath } from "node:fs";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import { errnoCode } from "../errors.ts";

const realpathNative = promisify(realpath.native);

export async function canonicalTrustPath(path: string, signal?: AbortSignal): Promise<string> {
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
