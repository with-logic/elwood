/** OS search permission is checked before CLI auto-detection (PRD §12A.5, C-CLI-21). */
import { accessSync, chmodSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import { writeEffectiveConfig } from "../../src/cli/config/effective.ts";
import { resolveRunSettings } from "../../src/cli/request/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { resetRuntimeSeamsForTests, setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { tempDir } from "../helpers/tmp.ts";
import { MemoryWriter } from "./run-fakes.ts";

const refused = vi.hoisted(() => ({ cwd: undefined as string | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: (...args: Parameters<typeof actual.access>) =>
      args[0] === refused.cwd
        ? Promise.reject(Object.assign(new Error("search denied"), { code: "EACCES" }))
        : actual.access(...args),
  };
});

afterEach(() => {
  refused.cwd = undefined;
  resetRuntimeSeamsForTests();
});

function resolveWithoutSearch(command: string, root: string, cwd: string) {
  const context = { env: {}, homeDir: root, invocationCwd: root };
  const probe = vi.fn(() => ({
    status: null,
    stdout: "",
    stderr: "",
    error: { code: "EACCES", message: "spawn failed" },
  }));
  setCommandRunnerForTests(probe);
  const parsed = parseCliArgs(["--cwd", cwd, "go"]);
  if (parsed.command !== "run") throw new Error("expected run");
  const result =
    command === "run"
      ? resolveRunSettings(parsed, context)
      : writeEffectiveConfig(["--cwd", cwd], {
          ...context,
          stdout: new AsyncOutputSink(new MemoryWriter()),
        });
  return { result, probe };
}

const searchRefusal = (cwd: string) => ({
  code: "invalid_arguments",
  message: `Workspace '${cwd}' cannot be entered; check directory search permissions.`,
});

for (const command of ["run", "config effective"]) {
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    `C-CLI-21 ${command} refuses a real owner directory without search permission`,
    async () => {
      const root = tempDir("workspace-search-permission-");
      const cwd = join(root, "workspace");
      mkdirSync(cwd, { mode: 0o700 });
      chmodSync(cwd, 0o600);
      try {
        expect(() => accessSync(cwd, constants.X_OK)).toThrow();
        const { result, probe } = resolveWithoutSearch(command, root, cwd);
        await expect(result).rejects.toMatchObject(searchRefusal(cwd));
        expect(probe).not.toHaveBeenCalled();
      } finally {
        chmodSync(cwd, 0o700);
      }
    },
  );
}

test.each([
  "run",
  "config effective",
])("C-CLI-21 %s classifies an OS search refusal independently of privilege", async (command) => {
  const root = tempDir("workspace-search-permission-");
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { mode: 0o700 });
  expect(() => accessSync(cwd, constants.X_OK)).not.toThrow();
  refused.cwd = cwd;
  const { result, probe } = resolveWithoutSearch(command, root, cwd);
  await expect(result).rejects.toMatchObject(searchRefusal(cwd));
  expect(probe).not.toHaveBeenCalled();
});
