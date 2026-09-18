/** Compiled-process new/resume and output-protocol coverage (PRD §12A.3, C-CLI-27). */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const entry = fileURLToPath(new URL("../../../dist/cli/entry.js", import.meta.url));
const preload = fileURLToPath(new URL("./session-preload.mjs", import.meta.url));

function invoke(root: string, args: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", preload, entry, ...args],
    {
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("ELWOOD_")),
      ),
      encoding: "utf8",
      input: "",
      timeout: 15_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CLI exited ${result.status}: ${result.stderr}`);
  return result;
}

describe("C-CLI-27 compiled CLI output", () => {
  test.each(["claude", "codex"] as const)("new and resumed %s output protocols", (agent) => {
    const root = mkdtempSync(join(tmpdir(), "elwood-compiled-cli-"));
    const common = ["--no-defaults", `--state-dir=${join(root, "state")}`];
    try {
      for (const show of [false, true]) {
        const flags = show ? ["--show-session-id"] : [];
        for (const output of ["text", "json", "jsonl"]) {
          const options = [...common, ...flags, `--output=${output}`];
          const first = invoke(root, [`--agent=${agent}`, ...options, "reply"]);
          const listing = JSON.parse(
            invoke(root, ["sessions", ...common, "--output=json"]).stdout,
          ) as {
            readonly sessions: readonly { readonly id: string }[];
          };
          const id = listing.sessions[0]!.id;
          const resumed = invoke(root, ["resume", id, ...options, "reply"]);
          for (const [result, phase] of [
            [first, "new"],
            [resumed, "resumed"],
          ] as const) {
            const answer = `${agent} ${phase} answer`;
            const value = result.stdout;
            expect(result.stderr).toBe(show && output === "text" ? `elwood: session ${id}\n` : "");
            if (output === "text") expect(value).toBe(`${answer}\n`);
            else {
              const records =
                output === "json"
                  ? [JSON.parse(value)]
                  : value
                      .trim()
                      .split("\n")
                      .map((line) => JSON.parse(line));
              expect(records.filter((record) => record.type === "result")).toEqual([
                expect.objectContaining({
                  schemaVersion: 1,
                  type: "result",
                  agent,
                  response: answer,
                  sessionId: id,
                }),
              ]);
              expect(value).not.toContain("elwood: session");
            }
          }
          const ephemeral = invoke(root, [
            "resume",
            id,
            ...common,
            "--ephemeral",
            "--show-session-id",
            "reply",
          ]);
          expect(ephemeral.stdout).toBe(`${agent} resumed answer\n`);
          expect(ephemeral.stderr).toBe("");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // Each `test.each` case spawns TWENTY-FOUR compiled-CLI processes: six option
    // combinations (`--show-session-id` off/on × text/json/jsonl), each running FOUR
    // invocations — `reply`, the `sessions` listing, `resume`, and the ephemeral run.
    // Measured per case on a lightly loaded machine: ~29s, because every process pays the
    // compiled entry's module-load cost (~670ms even for `--help`) rather than doing test
    // work. Against the former 60s budget that is under 2x headroom, so the case timed out
    // whenever the machine was busy — a load-sensitive failure that reads exactly like a
    // flake (#56). The budget is sized for the measured cost plus room for contention; a
    // genuine hang still fails well inside the suite runtime.
  }, 180_000);
});
