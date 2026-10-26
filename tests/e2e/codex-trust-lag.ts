/**
 * The launch shared by the Codex trust e2e tests whose screen trails the CLI (C-TRUST-01,
 * §5.4): a fresh untrusted git folder, a sandboxed home, autotrust, and a bogus model, so
 * a stray turn is refused before using quota. Codex's output is held from Elwood for a
 * fixed lag once Elwood writes its first trust answer, while Codex itself runs normally.
 * Teardown removes the scratch only once every Codex process is confirmed gone.
 */

import { execFileSync } from "node:child_process";
import type { TestContext } from "node:test";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { codexLaunches, endCodexTestAfter } from "./codex-test-end.ts";
import { bogusCodexModel, makeProject, sandboxedCodexHome } from "./helpers.ts";
import { type HeldOutput, holdCliOutput, outputMatcher } from "./output-hold.ts";

const directoryTrustOutput = /trustthisfolder\?|trustthecontentsofthisdirectory/i;

export type LaggedLaunch = {
  /** Codex's raw output, held or not, drew its directory-trust gate. */
  readonly displayed: boolean;
  /** Elwood wrote its first trust answer. Codex can discard it while its gate paints. */
  readonly answerWritten: boolean;
  /** Every string Elwood wrote to Codex, in order. */
  readonly writes: readonly string[];
};

export type LaggedCodex = { readonly session: CodexSessionApi; readonly launch: LaggedLaunch };

/**
 * Start Codex so that Elwood sees none of its output for `lagMs` after the first trust
 * answer write. `output` also sees each raw chunk, after `launch` has been updated by it.
 */
export async function startLaggedCodex(
  t: TestContext,
  lagMs: number,
  output?: (data: string, held: HeldOutput, launch: LaggedLaunch) => void,
): Promise<LaggedCodex> {
  const project = makeProject("codex");
  execFileSync("git", ["init", "-q", project.cwd]);
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  const launch = { displayed: false, answerWritten: false, writes: [] as string[] };
  const gate = outputMatcher(directoryTrustOutput);
  holdCliOutput({
    output(data, held) {
      if (!launch.displayed) launch.displayed = gate(data);
      output?.(data, held, launch);
    },
    input(data, held) {
      launch.writes.push(data);
      if (data !== "1\r" || launch.answerWritten) return;
      launch.answerWritten = true;
      held.hold(lagMs);
    },
  });
  let session: CodexSessionApi | undefined;
  const launches = codexLaunches();
  t.after(async () => {
    try {
      await endCodexTestAfter(t, { sessions: [session], sandbox, launches });
    } finally {
      resetRuntimeSeamsForTests();
    }
  });
  session = await launches.track(
    startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      model: bogusCodexModel,
      autotrust: true,
    }),
  );
  return { session, launch };
}
