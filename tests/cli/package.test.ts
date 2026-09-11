/**
 * Installed-artifact and Node process-boundary conformance coverage (PRD §12A, C-CLI-01/02).
 */

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { bootstrapCliIfMain, type CliProcess, runCli } from "../../src/cli/entry.ts";
import { main } from "../../src/cli/main.ts";
import { mainHarness } from "./main-fakes.ts";
import { MemoryWriter } from "./run-fakes.ts";

function fakeProcess(argv: readonly string[]): {
  readonly proc: CliProcess;
  readonly stdout: MemoryWriter;
  readonly stderr: MemoryWriter;
  readonly listeners: Set<() => void>;
} {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  Object.assign(stderr, {
    isTTY: true,
    columns: 100,
    rows: 30,
    on: () => undefined,
    off: () => undefined,
  });
  const listeners = new Set<() => void>();
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    on: () => undefined,
    off: () => undefined,
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {},
  };
  return {
    stdout,
    stderr,
    listeners,
    proc: {
      argv,
      stdout,
      stderr,
      stdin,
      env: {},
      cwd: () => "/tmp",
      on: (_event, handler) => listeners.add(handler),
      off: (_event, handler) => listeners.delete(handler),
      exitCode: undefined,
    },
  };
}

describe("installed CLI package", () => {
  test.each(
    ["help", "--help", "-h"].map((arg) => ({ args: [arg] })),
  )("C-CLI-02 renders help without an agent for $args", async ({ args }) => {
    const captured = mainHarness();
    expect(await main(args, captured.context)).toBe(0);
    expect(captured.stdout.value).toContain("Usage: elwood");
    expect(captured.stderr.value).toBe("");
  });

  test.each(
    ["--version", "-V"].map((arg) => ({ args: [arg] })),
  )("C-CLI-02 renders version for $args", async ({ args }) => {
    // Asserted against the manifest, not a literal: the version is the package's
    // to change, and a release bump must not fail this test.
    const { version } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { readonly version: string };
    const captured = mainHarness();
    expect(await main(args, captured.context)).toBe(0);
    expect(captured.stdout.value).toBe(`${version}\n`);
    expect(captured.stderr.value).toBe("");
  });

  test("C-CLI-01 entry binds arguments, streams, and status only when main", async () => {
    const h = fakeProcess(["node", "/tmp/elwood-entry.js", "--help"]);
    expect(bootstrapCliIfMain({ url: "file:///tmp/not-entry.js" }, h.proc)).toBeNull();
    const pending = bootstrapCliIfMain(
      { url: "file:///tmp/elwood-entry.js" },
      h.proc,
      undefined,
      "/tmp",
    );
    await expect(pending).resolves.toBe(0);
    expect(h.proc.exitCode).toBe(0);
    expect(h.stdout.value).toContain("Usage: elwood");

    const noEntry = fakeProcess(["node"]);
    expect(bootstrapCliIfMain({ url: "file:///tmp/elwood-entry.js" }, noEntry.proc)).toBeNull();
    const direct = fakeProcess(["node", "entry", "--help"]);
    await expect(runCli(direct.proc)).resolves.toBe(0);

    const fixture = mkdtempSync(join(tmpdir(), "elwood-entry-"));
    try {
      const entryPath = join(process.cwd(), "dist", "cli", "entry.js");
      const linkedPath = join(fixture, "elwood");
      symlinkSync(entryPath, linkedPath);
      const linked = fakeProcess(["node", linkedPath, "--help"]);
      await expect(
        bootstrapCliIfMain({ url: pathToFileURL(entryPath).href }, linked.proc, undefined, "/tmp"),
      ).resolves.toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("C-CLI-01 emitted entry is executable JavaScript with declarations", () => {
    accessSync("dist/cli/entry.js", constants.X_OK);
    expect(readFileSync("dist/cli/entry.js", "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/u);
    expect(readFileSync("dist/index.d.ts", "utf8")).toContain("export");
    const help = execFileSync(process.execPath, ["dist/cli/entry.js", "--help"], {
      encoding: "utf8",
    });
    expect(help).toContain("Usage: elwood");
    expect(execFileSync(process.execPath, ["dist/cli/entry.js"], { encoding: "utf8" })).toContain(
      "Usage: elwood",
    );
  });

  // This case shells out to `npm pack`, `tar`, and two fresh Node processes, so it
  // needs far more than the suite default when the parallel suite is loading the
  // machine; a timeout here was previously misread as a packaging failure.
  test("C-CLI-01 packed package runs through the installed bin symlink and imports", {
    timeout: 120_000,
  }, () => {
    const fixture = mkdtempSync(join(tmpdir(), "elwood-package-"));
    try {
      const packOutput = execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", fixture],
        { encoding: "utf8" },
      );
      const packed = JSON.parse(packOutput) as [{ readonly filename: string }];
      const packageDir = join(fixture, "consumer", "node_modules", "@with-logic", "elwood");
      const binDir = join(fixture, "consumer", "node_modules", ".bin");
      mkdirSync(packageDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      // The packed package declares runtime dependencies (node-pty) that the bare
      // consumer never installs; resolution walks up from the fixture to find them.
      symlinkSync(join(process.cwd(), "node_modules"), join(fixture, "node_modules"));
      execFileSync("tar", [
        "-xzf",
        join(fixture, packed[0].filename),
        "-C",
        packageDir,
        "--strip-components=1",
      ]);
      const binPath = join(binDir, "elwood");
      symlinkSync("../@with-logic/elwood/dist/cli/entry.js", binPath);

      expect(readlinkSync(binPath)).toBe("../@with-logic/elwood/dist/cli/entry.js");
      expect(execFileSync(binPath, ["--help"], { encoding: "utf8" })).toContain("Usage: elwood");
      expect(
        execFileSync(
          process.execPath,
          ["--input-type=module", "--eval", "await import('@with-logic/elwood')"],
          {
            cwd: join(fixture, "consumer"),
            encoding: "utf8",
          },
        ),
      ).toBe("");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
