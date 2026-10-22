/** Exercise configured private command and PTY boundaries without a native CLI (PRD §12). */
import { join } from "node:path";
import { expect, test } from "vitest";
import { currentCommandRunner, currentPtyFactory } from "../../src/runtime/seams.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { prefixShellArgument } from "../e2e/prefix-shell-argument.ts";
import { claudeProofMocks, nativeClaudeQuestionSandbox } from "./claude-proof-fixture.ts";

const mocks = claudeProofMocks();

test("private process seams pin commands, scrub PTY environment and record both write forms", async () => {
  const defaultRunner = currentCommandRunner();
  const defaultFactory = currentPtyFactory();
  const sandbox = await nativeClaudeQuestionSandbox();
  try {
    expect(mocks.keychain.mock.calls[0]?.[2]).toMatchObject({ encoding: "utf8", timeout: 5_000 });
    expect(mocks.probe).toHaveBeenNthCalledWith(1, "env", [
      `HOME=${sandbox.home}`,
      `CLAUDE_CONFIG_DIR=${sandbox.home}`,
      `ZDOTDIR=${sandbox.home}`,
      join(sandbox.root, "bin", "claude"),
      "--version",
    ]);
    await currentCommandRunner()("/bin/sh", ["-lc", "exec claude --version"]);
    const command = mocks.probe.mock.calls[1]!;
    expect(command[0]).toBe("env");
    expect(command[1].slice(0, 5)).toEqual([
      `HOME=${sandbox.home}`,
      `CLAUDE_CONFIG_DIR=${sandbox.home}`,
      `ZDOTDIR=${sandbox.home}`,
      "/bin/sh",
      "-lc",
    ]);
    expect(command[1].at(-1)).toContain(`PATH=${shellQuote(join(sandbox.root, "bin"))}:"$PATH"`);
    expect(command[1].at(-1)).toContain(
      "unset CLAUDECODE ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL;",
    );
    const pty = currentPtyFactory()({
      command: "/bin/sh",
      args: ["-lc", "exec claude"],
      cwd: sandbox.cwd,
      env: { KEEP: "yes", CLAUDECODE: "drop", CLAUDE_CODE_TEST: "drop", ANTHROPIC_API_KEY: "drop" },
      size: { cols: 80, rows: 24 },
    });
    const options = mocks.pty.mock.calls[0]![0];
    expect(options.args[0]).toBe("-lc");
    expect(options.args.at(-1)).toContain(`HOME=${shellQuote(sandbox.home)}`);
    expect(options.env).toEqual({
      KEEP: "yes",
      HOME: sandbox.home,
      CLAUDE_CONFIG_DIR: sandbox.home,
      ZDOTDIR: sandbox.home,
    });
    pty.write("first");
    pty.write(new Uint8Array([66]));
    expect(sandbox.writes).toEqual(["first", "B"]);
    expect(mocks.pty.mock.results[0]?.value).toMatchObject({ writes: ["first", "B"] });
  } finally {
    sandbox.dispose();
  }
  expect(currentCommandRunner()).toBe(defaultRunner);
  expect(currentPtyFactory()).toBe(defaultFactory);
});

test("shared shell transform preserves flags, input ownership and empty invocations", () => {
  const args = Object.freeze(["--login", "-c", "exec synthetic-cli"]);
  expect(prefixShellArgument(args, "export HOME='/private proof'")).toEqual([
    "--login",
    "-c",
    "export HOME='/private proof'; exec synthetic-cli",
  ]);
  expect(args).toEqual(["--login", "-c", "exec synthetic-cli"]);
  expect(prefixShellArgument([], "unused")).toEqual([]);
});
