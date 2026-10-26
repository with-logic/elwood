/**
 * A stand-in for the user's login shell, so a test that runs real probes does not depend on
 * the developer's or the CI runner's own shell. Elwood runs it as `<shell> -l -i -c <script>`.
 * Like a login shell, it reads a startup file, `$HOME/.profile`, and then runs the script in
 * the same shell, so the startup file's unexported assignments stay unexported. Shared by the
 * real-probe tests for PRD §4.2.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import * as shell from "../../src/runtime/shell.ts";

/** Writes the stand-in shell into `dir` and makes `userShell()` return it. */
export function useStandInLoginShell(dir: string): void {
  const path = join(dir, "login-shell");
  writeFileSync(
    path,
    '#!/bin/sh\n[ "$1 $2 $3" = "-l -i -c" ] || exit 64\n. "$HOME/.profile"\nshift 3\neval "$1"\n',
    { mode: 0o700 },
  );
  vi.spyOn(shell, "userShell").mockReturnValue(path);
}
