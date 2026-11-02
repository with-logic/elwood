/** Child-side working-directory guards before profiles and command execution (C-API-61). */
import type { DirectoryIdentity } from "../core/directory-identity.ts";
import { announcesStart, probeDirectoryRefusalScript } from "./probe/start.ts";
import { type LoginShellArgs, shellQuote } from "./shell.ts";

/** Internal refusal before the requested command runs; never an Elwood CLI exit status. */
export const directoryGuardExitCode = 96;

/**
 * Identity-free calls pass through unchanged. Otherwise a trusted shell checks its initial
 * cwd; login-shell calls also check the original path after profiles. Darwin/Linux guards
 * preserve a profile's deliberate cd and provide bounded validation, not atomic selection.
 */
export function checkedCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  identity: DirectoryIdentity | undefined,
  login: boolean,
  platform: NodeJS.Platform = process.platform,
): { readonly command: string; readonly args: readonly string[] } {
  if (identity === undefined) return { command, args };
  const dialect = statDialect(platform);
  const refusal = announcesStart(args) ? probeDirectoryRefusalScript : "";
  if (login) validateLoginShellArgs(args);
  const guardedArgs = login
    ? args.map((arg, index) =>
        index === 3 ? `${afterProfileGuard(cwd, identity, dialect, refusal)}${arg}` : arg,
      )
    : args;
  return {
    command: "/bin/sh",
    args: [
      "-p",
      "-c",
      `${directoryGuard(".", identity, dialect, refusal)}exec "$@"`,
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
  refusal: string,
): string {
  const statArgs = platform === "darwin" ? "-L -f '%d:%i'" : "-L -c '%d:%i'";
  return `[ "$(/usr/bin/stat ${statArgs} ${shellQuote(path)} 2>/dev/null)" = '${dev}:${ino}' ] || { ${refusal}exit ${directoryGuardExitCode}; }; `;
}

/** A profile's DEBUG trap must not write inside the guard’s stat command substitution. */
function afterProfileGuard(
  cwd: string,
  identity: DirectoryIdentity,
  platform: StatDialect,
  refusal: string,
): string {
  return `/bin/sh -p -c ${shellQuote(directoryGuard(cwd, identity, platform, refusal))} || exit ${directoryGuardExitCode}; `;
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
