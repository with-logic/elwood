/** Auto-detection validates the workspace before shell lookup (PRD §12A.5, C-CLI-03/21). */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import { writeEffectiveConfig } from "../../src/cli/config/effective.ts";
import { finalizeRunRequest, resolveRunSettings } from "../../src/cli/request/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { resetRuntimeSeamsForTests, setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { tempDir } from "../helpers/tmp.ts";
import { MemoryWriter } from "./run-fakes.ts";

afterEach(resetRuntimeSeamsForTests);

test.each([
  "run",
  "config effective",
])("C-CLI-03 %s rejects invalid auto-detection workspaces before probing", async (command) => {
  const root = tempDir("workspace-detection-validation-");
  const context = { env: {}, homeDir: root, invocationCwd: root };
  const file = join(root, "file");
  writeFileSync(file, "not a directory");
  const probe = vi.fn(() => ({
    status: null,
    stdout: "",
    stderr: "",
    error: { code: "ENOENT", message: "spawn failed" },
  }));
  setCommandRunnerForTests(probe);
  for (const [cwd, reason] of [
    [join(root, "missing"), "does not exist"],
    [file, "is not a directory"],
  ] as const) {
    const parsed = parseCliArgs(["--cwd", cwd, "go"]);
    if (parsed.command !== "run") throw new Error("expected run");
    const result =
      command === "run"
        ? resolveRunSettings(parsed, context)
        : writeEffectiveConfig(["--cwd", cwd], {
            ...context,
            stdout: new AsyncOutputSink(new MemoryWriter()),
          });
    await expect(result).rejects.toMatchObject({
      code: "invalid_arguments",
      message: `Workspace '${cwd}' ${reason}.`,
    });
  }
  expect(probe).not.toHaveBeenCalled();
});

test("C-CLI-03 explicit choices and resumes preserve workspace error precedence", async () => {
  const root = tempDir("workspace-detection-validation-");
  const cwd = join(root, "missing");
  const detect = vi.fn(async () => "claude" as const);
  for (const selection of [
    ["--agent", "codex"],
    ["--resume", "stored"],
  ]) {
    const parsed = parseCliArgs([...selection, "--cwd", cwd, "go"]);
    if (parsed.command !== "run") throw new Error("expected run");
    const result = resolveRunSettings(
      parsed,
      { env: {}, homeDir: root, invocationCwd: root },
      detect,
    );
    if (selection[0] === "--agent") await expect(result).resolves.toMatchObject({ cwd });
    else await expect(result).rejects.toThrow("--cwd cannot be used with --resume");
  }
  expect(detect).not.toHaveBeenCalled();
});

test("C-CLI-03 finalization rechecks a workspace validated before detection", async () => {
  const root = tempDir("workspace-detection-validation-");
  const parsed = parseCliArgs(["go"]);
  if (parsed.command !== "run") throw new Error("expected run");
  const draft = await resolveRunSettings(
    parsed,
    { env: {}, homeDir: root, invocationCwd: root },
    async () => "codex",
  );
  rmSync(root, { recursive: true });
  await expect(finalizeRunRequest(draft)).rejects.toMatchObject({
    code: "invalid_arguments",
    message: `Workspace '${root}' does not exist.`,
  });
});
