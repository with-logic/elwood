/** Unconfirmed peer outcomes are observable without claiming no attempt (PRD §9.2, C-LIFE-11). */
import { expect, test } from "vitest";
import { buildUpdateWarning } from "../../src/core/warnings/update.ts";
import {
  isUnconfirmedPeerUpdate,
  unconfirmedPeerUpdate,
} from "../../src/core/warnings/update-unconfirmed.ts";

for (const agent of ["claude", "codex"] as const) {
  test.each([
    false,
    true,
  ])(`C-LIFE-11 ${agent} peer uncertainty is not no-attempt=%s`, (notStarted) => {
    const error = unconfirmedPeerUpdate(agent);
    expect(isUnconfirmedPeerUpdate(error)).toBe(true);
    const warning = buildUpdateWarning(agent, "9.9.9", error, notStarted);
    expect(warning).toMatchObject({
      code: "agent_update_failed",
      errorCode: "update_unconfirmed",
      message: `\`${agent} update\` skipped: another updater's outcome could not be confirmed; continuing with the installed CLI 9.9.9.`,
      installedVersion: "9.9.9",
      raw: "",
    });
    expect(warning).not.toHaveProperty("exitStatus");
    expect(error.details).not.toHaveProperty("updateReason");
  });
}
