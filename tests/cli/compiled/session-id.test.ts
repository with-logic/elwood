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
  }, 60_000);
});
