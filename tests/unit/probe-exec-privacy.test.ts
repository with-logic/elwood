/** Profile environment and failed-exec hooks cannot enter diagnostics (C-PERF-05). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { probeShellCommand, shellQuote } from "../../src/runtime/shell.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});
for (const shell of ["/bin/zsh", "/bin/bash"] as const) {
  test.skipIf(!existsSync(shell))(
    `C-PERF-05 ${shell} startup cannot find capture paths or leak failed-exec hooks`,
    async () => {
      const root = tempDir("elwood-probe-exec-privacy-");
      const ran = join(root, "profile");
      const leaked = join(root, "environment");
      const profile =
        `echo loaded > ${shellQuote(ran)}\n` +
        `if [ -n "\${ELWOOD_PROBE_OUTPUT-}" ]; then echo exposed > ${shellQuote(leaked)}; echo FAKE-SECRET-env > "$ELWOOD_PROBE_OUTPUT/stderr"; fi\n` +
        `trap 'echo FAKE-SECRET-exit >&2' EXIT\ntrap 'echo FAKE-SECRET-debug >&2' DEBUG\n`;
      writeFileSync(join(root, shell === "/bin/zsh" ? ".zshrc" : ".bash_profile"), profile);
      vi.stubEnv("HOME", root);
      vi.stubEnv("ZDOTDIR", root);
      vi.stubEnv("TERM_PROGRAM", "");
      const result = await runProbe(
        shell,
        probeShellCommand("elwood-no-such-cli-private --version"),
      );
      expect(readFileSync(ran, "utf8")).toBe("loaded\n");
      expect(() => readFileSync(leaked)).toThrow(/ENOENT/);
      expect(result).toMatchObject({ status: 127, stdout: "" });
      expect(result.stderr).toContain("elwood-no-such-cli-private");
      expect(JSON.stringify(result)).not.toContain("FAKE-SECRET");
    },
  );
  test.skipIf(!existsSync(shell))(
    `C-PERF-05 ${shell} retains profile cd and PATH shim resolution`,
    async () => {
      const root = tempDir("elwood-probe-profile-resolution-");
      const shim = join(root, "elwood-profile-shim");
      writeFileSync(shim, '#!/bin/sh\nprintf "%s\\n" "$PWD"\n', { mode: 0o700 });
      writeFileSync(
        join(root, shell === "/bin/zsh" ? ".zshrc" : ".bash_profile"),
        `cd ${shellQuote(root)}\nexport PATH=${shellQuote(root)}:$PATH\n`,
      );
      vi.stubEnv("HOME", root);
      vi.stubEnv("ZDOTDIR", root);
      vi.stubEnv("TERM_PROGRAM", "");
      expect(await runProbe(shell, probeShellCommand("elwood-profile-shim"))).toMatchObject({
        status: 0,
        stdout: `${root}\n`,
        stderr: "",
      });
    },
  );
}

test("C-PERF-05 failed exec cannot reach a Bash profile wrapper's failure hook under capture", async () => {
  const root = tempDir("elwood-probe-exec-wrapper-");
  writeFileSync(
    join(root, ".bash_profile"),
    "elwood_failure_hook() { echo FAKE-SECRET-failure >&2; }\n" +
      'exec() { builtin exec "$@"; elwood_failure_hook; return 127; }\n',
  );
  vi.stubEnv("HOME", root);
  const result = await runProbe("/bin/bash", probeShellCommand("elwood-no-such-wrapper-cli"));
  expect(result.status).toBe(127);
  expect(result.stderr).toContain("elwood-no-such-wrapper-cli");
  expect(JSON.stringify(result)).not.toContain("FAKE-SECRET");
});
