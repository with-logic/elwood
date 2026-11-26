/** Run repository-owned usage protocol stand-ins through an isolated login shell (C-STATS-03/05). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import * as shell from "../../src/runtime/shell.ts";
import { tempDir } from "./tmp.ts";
import { writeWarmExecutable } from "./warm-executable.ts";

export function usageProtocolFixture(rc = "") {
  const root = tempDir("usage-protocol-");
  vi.stubEnv("HOME", root);
  vi.stubEnv("TERM_PROGRAM", "");
  vi.spyOn(shell, "userShell").mockReturnValue("/bin/bash");
  writeFileSync(
    join(root, ".bash_profile"),
    `export PATH=${shell.shellQuote(root)}:/usr/bin:/bin\n${rc}\n`,
  );
  return {
    root,
    cli(name: string, body: string) {
      writeWarmExecutable(join(root, name), `#!${process.execPath}\n${body}\n`);
    },
  };
}
