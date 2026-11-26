/**
 * The model probe's workspace trust policy (PRD §5.3, C-CLAUDE-26): on a Claude that discloses
 * hooks, 2.1.329 and later, it answers a plain workspace prompt and refuses one that discloses
 * hooks; on an older Claude, or one whose version is unparseable, it refuses every workspace
 * prompt. The version is the one Claude runs after any update. A refusal writes nothing, so the
 * folder stays untrusted, and tears the probe down.
 */

import { afterEach, expect, test } from "vitest";
import { claudeHooksDisclosureVersion } from "../../src/claude/preflight.ts";
import { ElwoodError } from "../../src/index.ts";
import type { CommandRunner } from "../../src/runtime/seams.ts";
import { claudeWorkspaceTrustScreen } from "../helpers/claude-workspace-trust-screen.ts";
import { until } from "../helpers/model-pickers.ts";
import { resetFakes } from "./helpers.ts";
import {
  type ProbeShown,
  probeEnd,
  probeShown as probeShownScreen,
  refused,
  reporting,
} from "./probe-trust-helpers.ts";

afterEach(resetFakes);

/** Starts the probe on a fake Claude and shows it the plain or hooks workspace prompt. */
const probeShown = (
  version: string | CommandRunner,
  prompt: "plain" | "hooks",
  autoupdate = false,
) =>
  probeShownScreen(version, (cwd) => claudeWorkspaceTrustScreen(cwd, "no", prompt), {
    autoupdate,
  });

/** The probe's first write, then whether it ended in the hooks refusal once the PTY exits. */
async function answered({ listing, pty }: ProbeShown) {
  await until(() => pty.writes.length > 0);
  const first = pty.writes[0];
  // The listing then waits for readiness; ending the probe here is enough.
  pty.emitExit({ exitCode: 0 });
  const refused = await listing.then(
    () => false,
    (error: unknown) =>
      error instanceof ElwoodError && error.details?.["category"] === "workspace_hooks",
  );
  return { first, refused };
}

/** Autotrust began its answer (Home, then Down to "Yes, I trust this folder"), unrefused. */
const answeredOutcome = { first: "\u001b[H\u001b[B", refused: false };

test("C-CLAUDE-26 Claude 2.1.329 is the first version the probe trusts to disclose hooks", () => {
  expect(claudeHooksDisclosureVersion).toBe("2.1.329");
});

test("C-CLAUDE-26 the probe refuses a prompt that discloses hooks", async () => {
  const end = await probeEnd(await probeShown("2.1.329", "hooks"));
  expect(end).toEqual(refused(/says this folder has hooks/));
});

test.each([
  ["older", "2.1.144"],
  ["the last that cannot disclose hooks", "2.1.328"],
  ["unparseable", "Claude Code (dev build)"],
])("C-CLAUDE-26 the probe refuses a plain prompt from a Claude whose version is %s", async (_, version) => {
  const end = await probeEnd(await probeShown(version, "plain"));
  expect(end).toEqual(
    refused(/shows a workspace trust prompt that cannot say whether this folder has hooks/),
  );
});

test("C-CLAUDE-26 the probe answers a plain prompt from a Claude that discloses hooks", async () => {
  expect(await answered(await probeShown("2.1.329", "plain"))).toEqual(answeredOutcome);
});

test("C-CLAUDE-26 the probe judges a plain prompt by the version Claude updated to", async () => {
  let updated = false;
  const updating: CommandRunner = (_command, args) => {
    if (args.join(" ").includes("claude update")) updated = true;
    return reporting(updated ? "2.1.329" : "2.1.328")(_command, args, {});
  };
  const shown = await probeShown(updating, "plain", true);
  expect(updated).toBe(true);
  expect(await answered(shown)).toEqual(answeredOutcome);
});
