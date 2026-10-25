/**
 * The detached sweep's failure accounting (PRD §5.3 and §9.4, C-LIFE-10): fixed reason
 * phrases, the first errno-shaped token, and a bounded list of the groups involved.
 */

import { describe, expect, test } from "vitest";
import {
  MAX_REPORTED_GROUPS,
  SweepFailures,
} from "../../src/runtime/shutdown/detached-sweep/failures.ts";

describe("C-LIFE-10 sweep failures", () => {
  test("nothing recorded is no failure", () => {
    expect(new SweepFailures().result()).toBeUndefined();
  });

  test("names at most MAX_REPORTED_GROUPS groups, each once", () => {
    const failures = new SweepFailures();
    const groups = Array.from({ length: 20 }, (_, index) => 7000 + index);
    failures.record("could not stop a live descendant group", undefined, groups);
    failures.record("could not stop a live descendant group", undefined, [7000]);
    expect(failures.result()?.processGroupIds).toEqual(groups.slice(0, MAX_REPORTED_GROUPS));
  });

  test("keeps the first errno-shaped token and drops raw error text", () => {
    const failures = new SweepFailures();
    const raw = (code: string) => Object.assign(new Error(`ps said: ${code}`), { code });
    failures.record("process table unreadable", raw("ETIMEDOUT"), []);
    failures.record("could not kill a signaled descendant group", raw("EPERM"), [7001]);
    expect(failures.result()).toMatchObject({
      message:
        "Could not reap detached descendants: process table unreadable (ETIMEDOUT); could not kill a signaled descendant group (EPERM)",
      code: "ETIMEDOUT",
      processGroupIds: [7001],
    });
  });
});
