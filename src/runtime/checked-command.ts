/** Child-side working-directory guards before profiles and command execution (C-API-61). */
import type { DirectoryIdentity } from "../core/directory-identity.ts";
import { shellQuote } from "./shell.ts";

/** Internal refusal before the requested command runs; never an Elwood CLI exit status. */
export const directoryGuardExitCode = 96;

/** A trusted non-login shell validates its kernel cwd before executing the user shell. */
export function checkedCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  identity: DirectoryIdentity | undefined,
  login: boolean,
  platform: string = process.platform,
): { readonly command: string; readonly args: readonly string[] } {
  if (identity === undefined) return { command, args };
  const guardedArgs = login
    ? args.map((arg, index) =>
        index === 3 ? `${afterProfileGuard(cwd, identity, platform)}${arg}` : arg,
      )
    : args;
  return {
    command: "/bin/sh",
    args: [
      "-p",
      "-c",
      `${directoryGuard(".", identity, platform)}exec "$@"`,
      "elwood-checked-cwd",
      command,
      ...guardedArgs,
    ],
  };
}

/** `.` names the kernel cwd held by the wrapper; an absolute path checks its launch entry. */
function directoryGuard(path: string, { dev, ino }: DirectoryIdentity, platform: string): string {
  const statArgs = platform === "darwin" ? "-L -f '%d:%i'" : "-L -c '%d:%i'";
  return `[ "$(/usr/bin/stat ${statArgs} ${shellQuote(path)} 2>/dev/null)" = '${dev}:${ino}' ] || exit ${directoryGuardExitCode}; `;
}

/** A profile's DEBUG trap must not write inside the guard’s stat command substitution. */
function afterProfileGuard(cwd: string, identity: DirectoryIdentity, platform: string): string {
  return `/bin/sh -p -c ${shellQuote(directoryGuard(cwd, identity, platform))} || exit ${directoryGuardExitCode}; `;
}
