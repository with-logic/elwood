/** Verify bounded descriptor reads for shared native Git scope evidence (C-CODEX-15). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseGitMetadataLine, readBoundedGitMetadataAsync } from "../../src/core/git-metadata.ts";
import { tempDir } from "../helpers/tmp.ts";

test("reads Git metadata verbatim and rejects non-files and excessive lengths", async () => {
  const cwd = tempDir("elwood-git-metadata-");
  const marker = join(cwd, ".git");
  const directory = join(cwd, "dir");
  const text = "gitdir: /project \r\n";
  mkdirSync(directory);
  writeFileSync(marker, text);
  await expect(readBoundedGitMetadataAsync(marker, 64)).resolves.toBe(text);
  await expect(readBoundedGitMetadataAsync(marker, 4)).resolves.toBeUndefined();
  await expect(readBoundedGitMetadataAsync(directory, 64)).resolves.toBeUndefined();
  expect(parseGitMetadataLine(text)).toBe("gitdir: /project ");
});

test("an aborted optional lookup does not open the file", async () => {
  const signal = AbortSignal.abort(new Error("Optional proof expired"));
  await expect(readBoundedGitMetadataAsync("/missing", 64, signal)).rejects.toBe(signal.reason);
});
