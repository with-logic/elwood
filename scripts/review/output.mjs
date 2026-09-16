/** Extracts a completed assistant answer from pinned OpenCode JSONL; implements PRD §16. */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

function accept(state, event) {
  const part = event?.part;
  if (!part || typeof part.messageID !== "string" || !part.messageID)
    throw new Error("Invalid event");
  if (event.type === "step_start") {
    if (state.current || state.seen.has(part.messageID)) throw new Error("Overlapping step");
    state.seen.add(part.messageID);
    state.current = { id: part.messageID, text: [] };
    state.answer = null;
    return;
  }
  if (!state.current || part.messageID !== state.current.id) throw new Error("Mismatched step");
  if (event.type === "text") {
    if (typeof part.text !== "string") throw new Error("Invalid text");
    state.current.text.push(part.text);
  } else if (event.type === "step_finish") {
    if (!["stop", "tool-calls"].includes(part.reason)) throw new Error("Incomplete step");
    state.answer = part.reason === "stop" ? state.current.text.join("\n") : null;
    state.current = null;
  } else if (!["tool_use", "reasoning"].includes(event.type)) {
    throw new Error("Unexpected event");
  }
}

export function finalText(input) {
  const state = { current: null, answer: null, seen: new Set() };
  for (const line of input.split(/\r?\n/u)) {
    if (line.trim()) accept(state, JSON.parse(line));
  }
  if (state.current || !state.answer?.trim()) throw new Error("Missing completed answer");
  return state.answer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.stdout.write(finalText(readFileSync(0, "utf8")));
  } catch {
    process.stderr.write("review: invalid or incomplete model event stream\n");
    process.exitCode = 1;
  }
}
