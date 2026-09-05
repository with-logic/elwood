/**
 * Provides the side-effect-free metadata command boundary for the Elwood CLI.
 * Implements PRD §12A.1 and C-CLI-02.
 */

import { readFileSync } from "node:fs";

export type CliMetadataWriter = {
  readonly write: (value: string) => unknown;
};

export type CliMetadataIo = {
  readonly stdout: CliMetadataWriter;
  readonly stderr: CliMetadataWriter;
};

const helpText = `Usage: elwood [options] [prompt...]
       elwood run [options] [prompt...]
       elwood config <path|show|get|set|unset>

Run a headless Claude Code or Codex turn and write its response to stdout.

Commands:
  run       Run one agent turn (the default command)
  config    View or change global defaults
  help      Show this help

Options:
  -h, --help       Show this help
  -V, --version    Show the Elwood version
`;

export function main(args: readonly string[], io: CliMetadataIo): number {
  if (isHelpRequest(args)) {
    io.stdout.write(helpText);
    return 0;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    io.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }
  io.stderr.write("Elwood CLI execution is not available in this build. Run 'elwood --help'.\n");
  return 2;
}

function isHelpRequest(args: readonly string[]): boolean {
  return (
    args.length === 0 ||
    (args.length === 1 && (args[0] === "help" || args[0] === "--help" || args[0] === "-h"))
  );
}

function readPackageVersion(): string {
  const json = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    readonly version: string;
  };
  return json.version;
}
