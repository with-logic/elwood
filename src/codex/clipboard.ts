/**
 * macOS clipboard save / set-image / restore for Codex image attachment. Codex
 * ingests an interactive image only from the OS clipboard (it reads `public.tiff`
 * off `NSPasteboard`), so Elwood writes the image there, triggers a paste, then
 * restores the user's prior clipboard. Async (never blocks the event loop) and
 * Codex-local, since this is Codex/macOS-specific mechanics. Implements PRD §5.3
 * (C-API-46).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { elwoodError } from "../core/errors.ts";

const run = promisify(execFile);

const OSASCRIPT = "/usr/bin/osascript";
const PBPASTE = "/usr/bin/pbpaste";
const PBCOPY = "/usr/bin/pbcopy";

// JXA hosting AppKit: load the file as an NSImage and lay it on the pasteboard
// with writeObjects, which writes the canonical `public.tiff` representation the
// `arboard` reader Codex uses expects. A bare JS array becomes an NSDictionary
// under the bridge and is rejected, so the image is wrapped in a real NSArray.
const SET_IMAGE_JXA =
  'function run(argv){ObjC.import("AppKit");' +
  "var img=$.NSImage.alloc.initWithContentsOfFile(argv[0]);" +
  'if(!img||img.isNil())throw new Error("image load failed");' +
  "var pb=$.NSPasteboard.generalPasteboard;pb.clearContents;" +
  "if(!pb.writeObjects($.NSArray.arrayWithObject(img)))" +
  'throw new Error("clipboard write failed");return "ok";}';

/** True only on macOS, where the NSPasteboard-backed attach path is available. */
export function clipboardImageSupported(): boolean {
  return process.platform === "darwin";
}

/**
 * The current clipboard text. Rejects with `image_attach_failed` when `pbpaste`
 * fails, so the caller can abort BEFORE mutating the clipboard rather than later
 * "restoring" an empty string over the user's real clipboard (C-API-46).
 */
export async function snapshotClipboardText(): Promise<string> {
  try {
    const { stdout } = await run(PBPASTE, [], { timeout: 5_000, encoding: "utf8" });
    return stdout;
  } catch (error) {
    throw elwoodError("image_attach_failed", "Could not read the clipboard.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Restores clipboard text captured by `snapshotClipboardText` (best-effort). */
export async function restoreClipboardText(text: string): Promise<void> {
  const child = run(PBCOPY, [], { timeout: 5_000 });
  child.child.stdin?.end(text);
  await child.catch(() => undefined);
}

/**
 * Writes the image file at `path` onto the macOS clipboard as a native image.
 * Rejects with `invalid_image` when the helper fails (unreadable/undecodable
 * file or an osascript failure), so the caller aborts before a paste that would
 * attach nothing (C-API-46).
 */
export async function setClipboardImage(path: string): Promise<void> {
  try {
    await run(OSASCRIPT, ["-l", "JavaScript", "-e", SET_IMAGE_JXA, path], { timeout: 10_000 });
  } catch (error) {
    const reason = clipboardErrorReason(error);
    throw elwoodError("invalid_image", `Could not place image on clipboard: ${reason}`, { path });
  }
}

function clipboardErrorReason(error: unknown): string {
  if (error && typeof error === "object") {
    const { stderr, message } = error as { stderr?: unknown; message?: unknown };
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "clipboard image write failed";
}
