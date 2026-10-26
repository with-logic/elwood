/**
 * The temp copies Codex saves of pasted images. Codex writes each image pasted into its
 * composer to a `codex-clipboard-*.png` file in its temp directory and never removes it, and
 * Elwood attaches every Codex image by pasting it (C-API-46). A session collects the copies
 * its own transcript names, in the `local_image` parts of the user messages it records, and
 * removes them once its CLI has exited. Implements PRD §5.3 (C-API-46).
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { isRecord } from "../../core/predicates.ts";
import { payloadOf } from "../transcript/payload.ts";

/** The name Codex gives a pasted image's copy (a random suffix, six characters or a UUID). */
const copyName = /^codex-clipboard-[A-Za-z0-9_-]+\.png$/;

/**
 * The pasted-image copies a committed transcript item names: the `local_image` paths of a
 * completed `UserMessage` that sit directly in `tempDir` under Codex's copy name. Any other
 * path, such as an image the user named by its own path, is never a copy.
 */
export function clipboardCopiesIn(item: unknown, tempDir: string): readonly string[] {
  const payload = payloadOf(item);
  const message = payload?.["type"] === "item_completed" ? payload["item"] : undefined;
  if (!(isRecord(message) && message["type"] === "UserMessage")) return [];
  const content = message["content"];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: unknown) => {
    const path = isRecord(part) && part["type"] === "local_image" ? part["path"] : undefined;
    return typeof path === "string" &&
      isAbsolute(path) &&
      copyName.test(basename(path)) &&
      resolve(dirname(path)) === tempDir
      ? [path]
      : [];
  });
}

/** The pasted-image copies one session's transcript has named. */
export class CodexClipboardCopies {
  // Codex inherits Elwood's environment, so its temp dir is this process's.
  private readonly tempDir = resolve(tmpdir());
  private readonly paths = new Set<string>();

  observe(item: unknown): void {
    for (const path of clipboardCopiesIn(item, this.tempDir)) this.paths.add(path);
  }

  /**
   * Removes every copy named so far. Best-effort and never throws: a copy that cannot be
   * removed is left for the OS to reap.
   */
  removeAll(): void {
    for (const path of this.paths) {
      try {
        unlinkSync(path);
      } catch {
        // Best-effort, as Elwood's own image temp files are (C-API-44).
      }
    }
    this.paths.clear();
  }
}
