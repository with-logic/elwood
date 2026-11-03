/** Workspace-dependent real-shell CLI resolution (PRD §12A.1/§12A.9, C-CLI-21/25). */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import { writeEffectiveConfig } from "../../src/cli/config/effective.ts";
import { spawnInteractiveAgent } from "../../src/cli/interactive/spawn.ts";
import { resolveRunSettings } from "../../src/cli/request/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import * as shell from "../../src/runtime/shell.ts";
import { tempDir } from "../helpers/tmp.ts";
import { MemoryWriter } from "./run-fakes.ts";

afterEach(() => {
  resetRuntimeSeamsForTests();
  vi.restoreAllMocks();
});

/** Each workspace resolves a different agent, without reading the user's startup files. */
function workspaceShell() {
  const root = tempDir("workspace-probes-");
  const invocation = join(root, "invocation");
  const target = join(root, "target with spaces");
  const started = join(root, "agent-started");
  for (const [cwd, agent] of [
    [invocation, "claude"],
    [target, "codex"],
  ] as const) {
    mkdirSync(join(cwd, "bin"), { recursive: true });
    writeFileSync(
      join(cwd, "bin", agent),
      `#!/bin/sh\nprintf '%s' "$PWD" > ${shell.shellQuote(started)}\n`,
      { mode: 0o700 },
    );
  }
  const program = join(root, "login-shell");
  writeFileSync(
    program,
    '#!/bin/sh\n[ "$1 $2 $3" = "-l -i -c" ] || exit 99\nexport PATH="$PWD/bin"\nshift\nshift\nexec /bin/sh "$@"\n',
    { mode: 0o700 },
  );
  vi.spyOn(shell, "userShell").mockReturnValue(program);
  return { root, invocation, target, started };
}

test.each([
  "invocation",
  "relative",
  "absolute",
] as const)("C-CLI-21 default detection probes the effective workspace (%s)", async (mode) => {
  const f = workspaceShell();
  const cwdArgs =
    mode === "invocation"
      ? []
      : ["--cwd", mode === "relative" ? "../target with spaces" : f.target];
  const parsed = parseCliArgs([...cwdArgs, "go"]);
  if (parsed.command !== "run") throw new Error("expected run");
  const result = await resolveRunSettings(parsed, {
    env: {},
    homeDir: f.root,
    invocationCwd: f.invocation,
  });
  expect(result.agent).toBe(mode === "invocation" ? "claude" : "codex");
  expect(result.cwd).toBe(mode === "invocation" ? f.invocation : f.target);
  expect(existsSync(f.started)).toBe(false); // detection never starts either agent
});

test("C-CLI-25 foreground PATH lookup runs in its launch workspace", async () => {
  const f = workspaceShell();
  await expect(
    spawnInteractiveAgent({ agent: "codex", command: "codex", args: [], cwd: f.target }),
  ).resolves.toBe(0);
  expect(readFileSync(f.started, "utf8")).toBe(realpathSync(f.target));
});

test("C-CLI-21 config effective detects from the selected workspace instead of the host cwd", async () => {
  const f = workspaceShell();
  vi.spyOn(process, "cwd").mockReturnValue(f.invocation);
  const writer = new MemoryWriter();
  await writeEffectiveConfig(["--cwd", f.target], {
    env: {},
    invocationCwd: f.invocation,
    homeDir: f.root,
    stdout: new AsyncOutputSink(writer),
  });
  expect(JSON.parse(writer.value)).toMatchObject({
    settings: {
      agent: { value: "codex", source: "auto-detected" },
      workspace: { value: f.target, source: "--cwd" },
    },
  });
  expect(existsSync(f.started)).toBe(false);
});
