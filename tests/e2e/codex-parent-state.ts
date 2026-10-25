/**
 * Fingerprint the parent's Codex files without exposing their contents (PRD §12). The
 * parent's Codex home is the suite's default (`codex-home.ts`), so a native proof checks
 * its private home leaked nothing there without reading the user's own Codex home.
 */
import { join } from "node:path";
import { defaultCodexHome } from "./codex-home.ts";
import { parentFileFingerprint } from "./parent-file-fingerprint.ts";

export function parentCodexConfigurationFingerprint(): string {
  return ["auth.json", "config.toml", "hooks.json"]
    .map((name) => parentFileFingerprint(join(defaultCodexHome, name)))
    .join(":");
}
