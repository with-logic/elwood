/** Reject special private files without blocking the host (PRD §8.2/§12A.5). */
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../helpers/tmp.ts";

describe("private file FIFO rejection", () => {
  test.each(["state", "config"])("C-CLI-15 rejects a %s FIFO before reading", (kind) => {
    const path = join(tempDir("elwood-fifo-"), "record");
    expect(spawnSync("mkfifo", [path]).status).toBe(0);
    chmodSync(path, 0o600);
    const module =
      kind === "state" ? "../../src/state/private-read.ts" : "../../src/cli/config/store.ts";
    const code = `
      import * as reader from ${JSON.stringify(new URL(module, import.meta.url).href)};
      try {
        ${kind === "state" ? "reader.readPrivateFile(process.argv[1], reader.currentFileOwner(), (message) => new Error(message))" : "reader.readConfig(process.argv[1])"};
        process.exitCode = 1;
      } catch (error) { console.log(error.message); }
    `;
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", code, path],
      { encoding: "utf8", timeout: 1_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/regular file/);
  });
});
