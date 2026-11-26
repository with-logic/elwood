/** Provides isolated Git commands for the workflow tests of PRD §16 and the release workflow. */
import { execFileSync } from "node:child_process";

/**
 * Runs Git in `cwd` with a fixed identity, no commit or tag signing and no
 * hooks, whatever the machine's Git configuration says. Returns trimmed stdout
 * and throws on a nonzero exit.
 */
export function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** Commits whatever is staged in `cwd`, even nothing, and returns the new commit's SHA. */
export function commit(cwd, message) {
  git(cwd, "commit", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}
