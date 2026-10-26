/**
 * The temp copies Codex saves of pasted images. Codex writes each image pasted into its
 * composer to a `codex-clipboard-*.png` file in its temp directory and never removes it, and
 * Elwood attaches every Codex image by pasting it (C-API-46). A session collects the copies
 * its own transcript names, in the `local_image` parts of the user messages it records, and
 * removes them once its CLI has exited. Implements PRD §5.3 (C-API-46).
 */

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, normalize, resolve, sep } from "node:path";
import { isRecord } from "../../core/predicates.ts";
import { payloadOf } from "../transcript/payload.ts";

/** The name Codex gives a pasted image's copy (a random suffix, six characters or a UUID). */
const copyNamePattern = /^codex-clipboard-[A-Za-z0-9_-]+\.png$/;

/** The `local_image` paths of a completed `UserMessage` transcript item, of any kind. */
export function localImagePathsIn(item: unknown): readonly string[] {
  const payload = payloadOf(item);
  const message = payload?.["type"] === "item_completed" ? payload["item"] : undefined;
  if (!(isRecord(message) && message["type"] === "UserMessage")) return [];
  const content = message["content"];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: unknown) => {
    const path = isRecord(part) && part["type"] === "local_image" ? part["path"] : undefined;
    return typeof path === "string" ? [path] : [];
  });
}

/**
 * The copy `path` names directly in `tempDir`, rebuilt from `tempDir` and its name, else
 * `undefined`. A path with a `..` segment never counts, since a link before it could lead
 * the original path out of `tempDir`; repeated separators, which Codex may write after a
 * `TMPDIR` that ends in one, do.
 */
export function clipboardCopyAt(path: string, tempDir: string): string | undefined {
  const name = basename(path);
  const copy = join(tempDir, name);
  const direct = normalize(path) === copy && !path.split(sep).includes("..");
  return copyNamePattern.test(name) && direct ? copy : undefined;
}

/**
 * The pasted-image copies a committed transcript item names: those of its `local_image`
 * paths that are copies directly in `tempDir`. Any other path, such as an image the user
 * named by its own path, is never a copy.
 */
export function clipboardCopiesIn(item: unknown, tempDir: string): readonly string[] {
  return localImagePathsIn(item).flatMap((path) => clipboardCopyAt(path, tempDir) ?? []);
}

/** The pasted-image copies one session's transcript has named. */
export class CodexClipboardCopies {
  // Elwood's temp dir. Codex starts through the user's login shell, which could point it
  // at another; copies there are not this session's to remove (PRD §5.3).
  private readonly tempDir = resolve(tmpdir());
  private readonly paths = new Set<string>();

  observe(item: unknown): void {
    for (const path of clipboardCopiesIn(item, this.tempDir)) this.paths.add(path);
  }

  /**
   * Removes every copy named so far, then calls `done`: at once when there are none, else
   * once the removals have finished. They run one at a time, so a session that pasted many
   * images never blocks the event loop on them. Best-effort, as Elwood's own image temp
   * files are (C-API-44): a copy that cannot be removed is left for the OS to reap.
   */
  removeAll(done: () => void): void {
    const paths = [...this.paths];
    this.paths.clear();
    if (paths.length === 0) {
      done();
      return;
    }
    // `done` runs outside the removal's promise, as a deferred exit already does.
    void removeEach(paths).then(() => queueMicrotask(done));
  }
}

async function removeEach(paths: readonly string[]): Promise<void> {
  for (const path of paths) await unlink(path).catch(() => undefined);
}
