/** Runs release workflow steps, as GitHub Actions expands them, for the release retry tests. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

/** Returns a job's text, from its key to the next job. */
export function job(name) {
  const jobs = workflow.split(/^ {2}(?=[\w-]+:\s*$)/mu);
  const text = jobs.find((part) => part.startsWith(`${name}:\n`));
  if (!text) throw new Error(`release.yml has no ${name} job.`);
  return text;
}

/**
 * Runs the step that opens with `- <header>` under bash, as a hosted runner
 * does, with its `env` and with Git isolated from the machine's configuration.
 * Every `${{ }}` expression in `env` and `run` takes its value from
 * `expressions`; a missing value throws so a new expression cannot pass as an
 * empty string. `prelude` runs first, to stub commands the step calls.
 */
export function runStep(header, { cwd, env = {}, expressions = {}, prelude = "" }) {
  const step = stepText(header);
  const expand = (text) =>
    text.replace(/\$\{\{\s*(.+?)\s*\}\}/gu, (_, name) => {
      if (!Object.hasOwn(expressions, name)) throw new Error(`No fixture value for ${name}.`);
      return expressions[name];
    });
  const envBlock = /^ {8}env:\n((?: {10}.+\n)+)/mu.exec(step)?.[1] ?? "";
  const stepEnv = {};
  for (const [, key, value] of envBlock.matchAll(/^ {10}(\w+): (.+)$/gmu)) {
    stepEnv[key] = expand(value);
  }
  const script = /^ {8}run: \|\n((?:(?: {10}.*)?\n)+)/mu.exec(step)?.[1];
  if (!script) throw new Error(`The "${header}" step has no \`run: |\` script.`);

  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-c", `${prelude}\n${expand(script)}`],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GITHUB_OUTPUT: "/dev/null",
        ...env,
        ...stepEnv,
      },
    },
  );
  if (result.error) throw result.error;
  return result;
}

/** Returns a step's keys: the lines after its header, up to the next step, comment or job. */
function stepText(header) {
  const opening = `\n      - ${header}\n`;
  const start = workflow.indexOf(opening);
  if (start < 0) throw new Error(`release.yml has no step opened by "- ${header}".`);
  const body = workflow.slice(start + opening.length);
  const end = body.search(/^ {0,6}\S/mu);
  return end < 0 ? body : body.slice(0, end);
}
