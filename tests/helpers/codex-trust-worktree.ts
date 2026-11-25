/** Build an on-disk linked Git registration for Codex trust tests. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function registerWorktree(checkout: string, repo: string) {
  const slot = join(repo, ".git", "worktrees", "test");
  const marker = join(checkout, ".git");
  mkdirSync(slot, { recursive: true });
  writeFileSync(marker, `gitdir: ${slot}\n`);
  writeFileSync(join(slot, "gitdir"), `${marker}\n`);
  writeFileSync(join(slot, "commondir"), "../..\n");
  return { slot, marker };
}
