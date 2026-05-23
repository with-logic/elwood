/**
 * Conformance tests for the initial project contract.
 * Covers PRD §0.
 */

import { describe, expect, test } from "bun:test";
import { describeProject, projectName } from "../src/index.ts";

describe("project contract", () => {
  test("C-EXAMPLE-01 describes the initial project contract", () => {
    expect(projectName).toBe("elwood");
    expect(describeProject()).toBe("elwood is specified by PRD.md");
  });
});
