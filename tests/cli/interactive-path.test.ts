/** Foreground launch resolves the detected shell PATH without changing argv/status (C-CLI-25). */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { spawnInteractiveAgent } from "../../src/cli/interactive/spawn.ts";
import { loginShellResolves } from "../../src/cli/request/agent-detect.ts";
import * as shell from "../../src/runtime/shell.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "interactive-path-"));
  roots.push(root);
  const bin = join(root, "shell bin");
  mkdirSync(bin);
  const startup = join(root, "shell");
  writeFileSync(
    startup,
    `#!/bin/sh\nprintf 'startup noise\\n'\nexport PATH=${shell.shellQuote(bin)}:$PATH\nshift\nshift\nexec /bin/sh "$@"\n`,
    { mode: 0o700 },
  );
  vi.spyOn(shell, "userShell").mockReturnValue(startup);
  return { root, bin, startup };
}
test("C-CLI-25 shell-only executable resolves and receives literal arguments with exit 127 intact", async () => {
  const f = fixture();
  const output = join(f.root, "args");
  const name = "claude";
  writeFileSync(
    join(f.bin, name),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${shell.shellQuote(output)}\nexit 127\n`,
    { mode: 0o700 },
  );
  expect(await loginShellResolves(name, f.startup)).toBe(true);
  expect(
    await spawnInteractiveAgent({
      agent: "claude",
      command: name,
      args: ["a b", "'quoted'", "$(false)"],
      cwd: f.root,
    }),
  ).toBe(127);
  expect(readFileSync(output, "utf8")).toBe("a b\n'quoted'\n$(false)\n");
});
test("C-CLI-25 failing shell startup maps to an adapter start error", async () => {
  const f = fixture();
  writeFileSync(f.startup, "#!/bin/sh\nexit 9\n");
  await expect(
    spawnInteractiveAgent({ agent: "codex", command: "unused", args: [], cwd: f.root }),
  ).rejects.toMatchObject({ code: "codex_start_failed" });
});

test.each([
  "",
  "printf 'startup noise'",
  "printf '\\0partial'",
])("C-CLI-25 successful shell exit without a complete frame preserves PATH (%s)", async (output) => {
  const f = fixture();
  writeFileSync(f.startup, `#!/bin/sh\n${output}\nexit 0\n`);
  writeFileSync(join(f.bin, "elwood-test-agent"), "#!/bin/sh\nexit 7\n", { mode: 0o700 });
  vi.stubEnv("PATH", f.bin);
  expect(
    await spawnInteractiveAgent({
      agent: "claude",
      command: "elwood-test-agent",
      args: [],
      cwd: f.root,
    }),
  ).toBe(7);
});
test("C-CLI-25 a framed empty PATH remains authoritative", async () => {
  const f = fixture();
  writeFileSync(f.startup, "#!/bin/sh\nprintf '\\0\\0'\n");
  writeFileSync(join(f.bin, "elwood-test-agent"), "#!/bin/sh\nexit 7\n", { mode: 0o700 });
  vi.stubEnv("PATH", f.bin);
  await expect(
    spawnInteractiveAgent({
      agent: "codex",
      command: "elwood-test-agent",
      args: [],
      cwd: f.root,
    }),
  ).rejects.toMatchObject({ code: "codex_not_found" });
});
