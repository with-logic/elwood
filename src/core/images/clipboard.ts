/**
 * macOS clipboard save / set-image / restore for Codex image attachment. Codex
 * ingests an interactive image only from the OS clipboard (it reads `public.tiff`
 * off `NSPasteboard`), so Elwood writes the image there, triggers a paste, then
 * restores the user's prior clipboard. Implements PRD §5.3 (C-API-46).
 */

import { spawnSync } from "node:child_process";
import { elwoodError } from "../errors.ts";

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

/** The current clipboard text, or "" when empty/unavailable (best-effort snapshot). */
export function snapshotClipboardText(): string {
  const result = spawnSync(PBPASTE, [], { encoding: "utf8", timeout: 5_000 });
  return typeof result.stdout === "string" ? result.stdout : "";
}

/** Restores clipboard text captured by `snapshotClipboardText` (best-effort). */
export function restoreClipboardText(text: string): void {
  spawnSync(PBCOPY, [], { input: text, timeout: 5_000 });
}

/**
 * Writes the image file at `path` onto the macOS clipboard as a native image.
 * Throws `invalid_image` when the helper fails (unreadable/undecodable file or
 * an osascript failure), so the caller aborts before triggering a paste that
 * would attach nothing (C-API-46).
 */
export function setClipboardImage(path: string): void {
  const result = spawnSync(OSASCRIPT, ["-l", "JavaScript", "-e", SET_IMAGE_JXA, path], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status === 0) return;
  const reason = (result.stderr || result.error?.message || "clipboard image write failed").trim();
  throw elwoodError("invalid_image", `Could not place image on clipboard: ${reason}`, { path });
}
