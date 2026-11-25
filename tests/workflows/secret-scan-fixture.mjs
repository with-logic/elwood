/** Provides Git fixtures and the shell step for PRD §16 secret-scan tests. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const workflow = readFileSync(
  new URL("../../.github/workflows/secret-scan.yml", import.meta.url),
  "utf8",
);
export const scanScript = /^ +id: scan\n[\s\S]*?^ +run: \|\n([\s\S]+?)(?=^ {6}- name:)/mu.exec(
  workflow,
)?.[1];
const rangeEnd = /\n +# End scan range selection\./u;
if (!(scanScript && rangeEnd.test(scanScript))) {
  throw new Error("The scan step must select its range before creating reports.");
}
export const rangeScript = scanScript.split(rangeEnd, 1)[0];

export const dockerWithFinding = [
  "docker() {",
  '  local arg report_dir="" matched=false',
  '  for arg in "$@"; do',
  '    case "$arg" in',
  `      *:/reports) report_dir=\${arg%:/reports} ;;`,
  '      "--log-opts=$EXPECTED_SCAN_RANGE "*) matched=true ;;',
  "    esac",
  "  done",
  '  [[ "$matched" == true && -n "$report_dir" ]] || return 125',
  '  printf \'[{"RuleID":"fixture","StartLine":1,"Commit":"%s"}]\\n\' "$SCAN_HEAD" > "$report_dir/findings.json" || return 125',
  "  return 20",
  "}",
].join("\n");

export function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

export function commit(cwd, message) {
  git(cwd, "commit", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}
