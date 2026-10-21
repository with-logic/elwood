/** Fingerprint parent Codex files without exposing their contents (PRD §12). */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function parentCodexConfiguration(): string {
  return ["auth.json", "config.toml", "hooks.json"]
    .map((name) => {
      const path = join(homedir(), ".codex", name);
      return existsSync(path)
        ? createHash("sha256").update(readFileSync(path)).digest("hex")
        : "absent";
    })
    .join(":");
}
