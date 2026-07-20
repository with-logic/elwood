/**
 * Focused coverage for Codex shell/exec transcript items (PRD §5.4/§7A.4,
 * C-CODEX-19): the command surfaces as a `tool_call` across every CLI shape
 * (`custom_tool_call` exec with the command in `input`, `function_call`
 * shell/exec_command with it in `arguments`), and the output surfaces as a
 * `tool_result` — including the `input_text[]` array form that was dropped before.
 */

import { describe, expect, test } from "vitest";
import { summarizeTranscriptItem } from "../../src/codex/transcript.ts";

function summary(payload: Record<string, unknown>) {
  return summarizeTranscriptItem({ type: "response_item", payload });
}

describe("Codex shell/exec transcript summaries (C-CODEX-19)", () => {
  test("C-CODEX-19 exec/shell calls surface their command across every representation", () => {
    // Modern `exec`: a custom_tool_call whose command is a freeform string in `input`
    // (NOT arguments) — this is the shape that previously fell to a blank `other` row.
    expect(
      summary({
        type: "custom_tool_call",
        name: "exec",
        call_id: "c1",
        input: 'const r = await tools.exec_command({cmd:"ls -la"}); text(r.output);',
      }),
    ).toEqual({
      kind: "tool_call",
      label: "exec",
      text: 'const r = await tools.exec_command({cmd:"ls -la"}); text(r.output);',
    });
    // Classic `shell`: a function_call with the argv command in JSON-string arguments.
    expect(
      summary({
        type: "function_call",
        name: "shell",
        arguments: '{"command":["bash","-lc","ls"]}',
      }),
    ).toEqual({ kind: "tool_call", label: "shell", text: '{"command":["bash","-lc","ls"]}' });
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
