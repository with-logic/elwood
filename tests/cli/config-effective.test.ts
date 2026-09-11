/**
 * Effective-setting inspection and validation tests (PRD §12A.4, C-CLI-19/C-CLI-21).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { writeEffectiveConfig } from "../../src/cli/config/effective.ts";
import { autoDetectedSource } from "../../src/cli/request/agent-detect.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { createSessionRecord } from "../../src/state/store.ts";
import { detectClaude, detectCodex, detectNothing } from "./agent-fakes.ts";
import { MemoryWriter } from "./run-fakes.ts";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "elwood-effective-config-"));
  const writer = new MemoryWriter();
  return {
    root,
    writer,
    context: {
      env: {},
      invocationCwd: root,
      homeDir: root,
      stdout: new AsyncOutputSink(writer),
    },
  };
}

describe("effective config", () => {
  test("C-CLI-19/C-CLI-21 can ignore defaults and report auto-detected and debug provenance", async () => {
    const h = harness();
    await writeEffectiveConfig(["--no-defaults", "--debug"], h.context, {
      detectAgent: detectCodex,
    });
    expect(JSON.parse(h.writer.value)).toMatchObject({
      type: "effective-settings",
      config: { loaded: false },
      settings: {
        agent: { value: "codex", source: autoDetectedSource },
        debug: { value: true, source: "--debug" },
        head: { value: false, source: "built-in" },
        allowedTools: { value: null, source: "not applicable" },
        disallowedTools: { value: null, source: "not applicable" },
        tools: { value: null, source: "not applicable" },
      },
    });
  });

  test("C-CLI-21 reports an auto-detected Claude with its posture, and no agent as a failure", async () => {
    const h = harness();
    await writeEffectiveConfig([], h.context, { detectAgent: detectClaude });
    expect(JSON.parse(h.writer.value).settings).toMatchObject({
      agent: { value: "claude", source: autoDetectedSource },
      permissionMode: { value: "dontAsk", source: "built-in" },
      sandbox: { value: null, source: "not applicable" },
    });
    await expect(
      writeEffectiveConfig([], harness().context, { detectAgent: detectNothing }),
    ).rejects.toMatchObject({ code: "no_agent_found" });
  });

  test("C-CLI-19 reports headed output mode and provenance", async () => {
    const h = harness();
    await writeEffectiveConfig(["--head"], h.context, { detectAgent: detectCodex });
    expect(JSON.parse(h.writer.value).settings.head).toEqual({ value: true, source: "--head" });
  });

  test("C-CLI-19 resolves stored adapter and workspace provenance", async () => {
    const h = harness();
    const base = createSessionRecord({ cwd: h.root, id: "s1", adapter: "claude" });
    const record = {
      ...base,
      claude: {
        launch: {
          permissionMode: "bypassPermissions" as const,
          allowedTools: ["Bash"],
          disallowedTools: ["WebFetch"],
          tools: [] as readonly string[],
        },
      },
    };
    await writeEffectiveConfig(["--resume", "s1"], h.context, {
      readRecord: () => record,
      detectAgent: detectNothing,
    });
    expect(JSON.parse(h.writer.value).settings).toMatchObject({
      agent: { value: "claude", source: "stored session s1" },
      workspace: { value: h.root, source: "stored session s1" },
      permissionMode: { value: "dontAsk", source: "built-in" },
      allowedTools: { value: ["Bash"], source: "stored session s1" },
      disallowedTools: { value: ["WebFetch"], source: "stored session s1" },
      tools: { value: [], source: "stored session s1" },
      head: { value: false, source: "built-in" },
    });
  });

  test("C-CLI-19 reports unset Claude tool policy on a new session", async () => {
    const h = harness();
    await writeEffectiveConfig(["--agent", "claude"], h.context, { detectAgent: detectNothing });
    expect(JSON.parse(h.writer.value).settings).toMatchObject({
      allowedTools: { value: null, source: "unset" },
      disallowedTools: { value: null, source: "unset" },
      tools: { value: null, source: "unset" },
    });
  });

  test.each([
    [["--help"], /run options only/iu],
    [["a prompt"], /options, not a prompt/iu],
    [["--image", "x.png"], /does not accept --image/iu],
  ])("C-CLI-19 rejects non-setting input %#", async (args, message) => {
    const h = harness();
    await expect(writeEffectiveConfig(args, h.context)).rejects.toThrow(message);
  });
});
