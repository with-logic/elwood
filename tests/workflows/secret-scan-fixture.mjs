/** Provides the shell step and Docker stub for PRD §16 secret-scan tests. */
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
