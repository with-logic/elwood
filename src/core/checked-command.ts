/** Child-side working-directory guards before profiles and command execution (C-API-61). */
import { directoryGuardExitCode, directoryGuardStopMarker } from "./directory-guard.ts";
import type { DirectoryIdentity } from "./directory-identity.ts";
import { type LoginShellArgs, shellQuote } from "./shell.ts";

export { directoryGuardExitCode } from "./directory-guard.ts";

/**
 * Identity-free calls pass through unchanged. Otherwise a trusted shell checks its initial
 * cwd; login-shell calls also check the original path after profiles. Darwin/Linux guards
 * preserve a profile's deliberate cd and provide bounded validation, not atomic selection.
 */
export function wrapCommandWithDirectoryGuard(
  command: string,
  args: readonly string[],
  cwd: string,
  identity: DirectoryIdentity | undefined,
  login: boolean,
  platform: NodeJS.Platform = process.platform,
): { readonly command: string; readonly args: readonly string[] } {
  if (identity === undefined) return { command, args };
  const dialect = statDialect(platform);
  if (login) validateLoginShellArgs(args);
  const guardedArgs = login
    ? args.map((arg, index) =>
        index === 3 ? `${afterProfileGuard(cwd, identity, dialect)}${arg}` : arg,
      )
    : args;
  return {
    command: "/bin/sh",
    args: [
      "-p",
      "-c",
      `${directoryGuard(".", identity, dialect)}exec "$@"`,
      // The placeholder occupies $0; keep the requested command after it, inside "$@".
      "elwood-checked-cwd",
      command,
      ...guardedArgs,
    ],
  };
}

/** `.` names the kernel cwd held by the wrapper; an absolute path checks its launch entry. */
function directoryGuard(
  path: string,
  { dev, ino }: DirectoryIdentity,
  platform: StatDialect,
): string {
  const statArgs = platform === "darwin" ? "-L -f '%d:%i'" : "-L -c '%d:%i'";
  const write = `printf '%s\\n' ${shellQuote(directoryGuardStopMarker)}`;
  const refusal = `{ ${write} >/dev/tty; } 2>/dev/null || ${write}; `;
  return `[ "$(/usr/bin/stat ${statArgs} ${shellQuote(path)} 2>/dev/null)" = '${dev}:${ino}' ] || { ${refusal}exit ${directoryGuardExitCode}; }; `;
}

/** A profile's DEBUG trap must not write inside the guard’s stat command substitution. */
function afterProfileGuard(
  cwd: string,
  identity: DirectoryIdentity,
  platform: StatDialect,
): string {
  return `/bin/sh -p -c ${shellQuote(directoryGuard(cwd, identity, platform))} || exit ${directoryGuardExitCode}; `;
}

/** Guard syntax exists only for the stat tools shipped on these hosts. */
type StatDialect = "darwin" | "linux";
function statDialect(platform: NodeJS.Platform): StatDialect {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new Error(`Checked-directory launches do not support ${platform}.`);
}

/** A guarded login launch must retain the builder's fourth-argument script position. */
function validateLoginShellArgs(args: readonly string[]): asserts args is LoginShellArgs {
  if (
    args.length !== 4 ||
    args[0] !== "-l" ||
    args[1] !== "-i" ||
    args[2] !== "-c" ||
    typeof args[3] !== "string"
  )
    throw new TypeError("Expected login-shell arguments [-l, -i, -c, script].");
}
