/**
 * Focused coverage for Codex shell/exec transcript items (PRD §5.4/§7A.4,
 * C-CODEX-19): the ACTUAL command surfaces as a `tool_call` UNWRAPPED from the CLI's
 * JS/JSON harness across every shape (modern `exec` JS wrapper, classic `shell`
 * JSON `arguments`), with a raw fallback when nothing parses; the output surfaces
 * as a `tool_result` — including the `input_text[]` array form.
 */

import { describe, expect, test } from "vitest";
import { summarizeTranscriptItem } from "../../src/codex/transcript.ts";

function summary(payload: Record<string, unknown>) {
  return summarizeTranscriptItem({ type: "response_item", payload });
}

describe("Codex shell/exec transcript summaries (C-CODEX-19)", () => {
  test("C-CODEX-19 modern exec unwraps the bare command from the JS harness", () => {
    // The exact shape real Codex emits: a JS snippet wrapping tools.exec_command with
    // the command in `cmd` plus harness fields (workdir, yield_time_ms). Only the
    // command survives — not the JS, not the workdir/limits.
    expect(
      summary({
        type: "custom_tool_call",
        name: "exec",
        call_id: "c1",
        input:
          'const r = await tools.exec_command({"cmd":"echo ELWOOD_OK","workdir":"/tmp/x","yield_time_ms":10000,"max_output_tokens":1000}); text(r.output);\n',
      }),
    ).toEqual({ kind: "tool_call", label: "exec", text: "echo ELWOOD_OK" });
  });

  test("C-CODEX-19 a `command` array is joined, and a JSON `arguments` shell call unwraps", () => {
    // Classic `shell`: a function_call with an argv array in JSON-string arguments.
    expect(
      summary({
        type: "function_call",
        name: "shell",
        arguments: '{"command":["bash","-lc","ls -la"]}',
      }),
    ).toEqual({ kind: "tool_call", label: "shell", text: "bash -lc ls -la" });
    // A `command` string (not array) is surfaced directly.
    expect(
      summary({ type: "function_call", name: "exec_command", arguments: '{"command":"pwd"}' }).text,
    ).toBe("pwd");
  });

  test("C-CODEX-19 an unparseable or command-less invocation falls back to the raw input", () => {
    // No embedded JSON object → raw fallback (a command is never lost).
    expect(summary({ type: "custom_tool_call", name: "exec", input: "not json at all" }).text).toBe(
      "not json at all",
    );
    // Embedded JSON with no command/cmd → raw fallback.
    const noCmd = '{"workdir":"/tmp"}';
    expect(summary({ type: "function_call", name: "shell", arguments: noCmd }).text).toBe(noCmd);
    // A non-string command (e.g. a number) → raw fallback.
    const badCmd = '{"command":42}';
    expect(summary({ type: "function_call", name: "shell", arguments: badCmd }).text).toBe(badCmd);
    // A command array with a non-string entry → raw fallback.
    const mixedArr = '{"command":["ls",7]}';
    expect(summary({ type: "function_call", name: "shell", arguments: mixedArr }).text).toBe(
      mixedArr,
    );
    // Malformed JSON that starts a brace but never closes → raw fallback.
    const unbalanced = 'tools.exec_command({"cmd":"ls"';
    expect(summary({ type: "custom_tool_call", name: "exec", input: unbalanced }).text).toBe(
      unbalanced,
    );
    // Brace-BALANCED but not valid JSON (unquoted key) → JSON.parse throws → raw.
    const balancedBadJson = "tools.exec_command({cmd: ls})";
    expect(summary({ type: "custom_tool_call", name: "exec", input: balancedBadJson }).text).toBe(
      balancedBadJson,
    );
    // A non-string `input` (no command) yields no text.
    expect(summary({ type: "custom_tool_call", name: "exec", input: 42 }).text).toBeUndefined();
  });

  test("C-CODEX-19 a `cmd` value containing braces is extracted whole (balanced scan)", () => {
    // The brace-balanced scan (not a greedy regex) handles a command that itself
    // contains `{` `}` inside a JSON string.
    expect(
      summary({
        type: "custom_tool_call",
        name: "exec",
        input: 'tools.exec_command({"cmd":"awk \'{print $1}\' f"});',
      }).text,
    ).toBe("awk '{print $1}' f");
  });

  test("C-CODEX-19 escaped quotes/backslashes inside the command are handled by the scanner", () => {
    // The scan tracks string state so an escaped `\"` (and a literal `\\`) inside the
    // command does NOT prematurely end the JSON string or the brace span.
    const input = String.raw`tools.exec_command({"cmd":"echo \"hi\" && cat a\\b"});`;
    expect(summary({ type: "custom_tool_call", name: "exec", input }).text).toBe(
      String.raw`echo "hi" && cat a\b`,
    );
  });

  test("C-CODEX-19 exec/shell OUTPUT is classified as tool_result with its text joined", () => {
    // custom_tool_call_output was previously dropped to `other`; now it's a tool_result
    // and its input_text[] entries are joined into readable output text.
    expect(
      summary({
        type: "custom_tool_call_output",
        call_id: "c1",
        output: [
          { type: "input_text", text: "Script completed\nOutput:\n" },
          { type: "input_text", text: "total 8\n" },
        ],
      }),
    ).toEqual({ kind: "tool_result", label: "c1", text: "Script completed\nOutput:\ntotal 8\n" });
    // A plain-string output (classic function_call_output) still works.
    expect(summary({ type: "function_call_output", call_id: "c2", output: "stdout here" })).toEqual(
      {
        kind: "tool_result",
        label: "c2",
        text: "stdout here",
      },
    );
    // A non-string/non-array output, or an array with no text entries, yields no text.
    expect(summary({ type: "custom_tool_call_output", call_id: "c3", output: 42 }).text).toBe(
      undefined,
    );
    expect(
      summary({ type: "custom_tool_call_output", call_id: "c4", output: [{ type: "x" }] }).text,
    ).toBeUndefined();
  });
});
