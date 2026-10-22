/** Fingerprint parent Codex files without exposing their contents (PRD §12). */
import { homedir } from "node:os";
import { join } from "node:path";
import { parentFileFingerprint } from "./parent-file-fingerprint.ts";

export function parentCodexConfigurationFingerprint(): string {
  return ["auth.json", "config.toml", "hooks.json"]
    .map((name) => parentFileFingerprint(join(homedir(), ".codex", name)))
    .join(":");
}
