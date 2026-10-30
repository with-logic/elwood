/**
 * Which `local_image` paths in a Codex transcript item are Codex's own copies of pasted
 * images (PRD §5.3, C-API-46), in the shape codex-cli 0.164 records them: a completed
 * `UserMessage` item naming `<TMPDIR>/codex-clipboard-<suffix>.png`.
 */

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { clipboardCopiesIn } from "../../src/codex/images/clipboard-copies.ts";

const tmp = "/var/folders/xx/T";

/** A committed `item_completed` record of a user message with these content parts. */
function userMessage(content: unknown, type = "UserMessage"): unknown {
  return {
    type: "event_msg",
    payload: { type: "item_completed", item: { type, id: "m1", content } },
  };
}

const image = (path: unknown) => ({ type: "local_image", path });

describe("C-API-46 Codex clipboard copies named by a transcript item", () => {
  test("both of Codex's copy names in the temp dir are copies", () => {
    const short = join(tmp, "codex-clipboard-9u1oJM.png");
    const uuid = join(tmp, "codex-clipboard-e1d1e7eb-3436-4401-86e8-60ee33ca2823.png");
    const item = userMessage([image(short), { type: "text", text: "[Image #1]" }, image(uuid)]);
    expect(clipboardCopiesIn(item, tmp)).toEqual([short, uuid]);
  });

  test("a path with a repeated separator names the copy, rebuilt from the temp dir", () => {
    const copy = join(tmp, "codex-clipboard-abc123.png");
    const named = `${tmp}//codex-clipboard-abc123.png`;
    expect(clipboardCopiesIn(userMessage([image(named)]), tmp)).toEqual([copy]);
  });

  test.each([
    ["an image the user named by its own path", "/work/project/codex-clipboard-abc123.png"],
    ["a copy-like name in a subdirectory", join(tmp, "nested", "codex-clipboard-abc123.png")],
    ["another file in the temp dir", join(tmp, "shot.png")],
    ["a name that only starts like a copy", join(tmp, "codex-clipboard-abc123.png.keep")],
    ["a relative path", "codex-clipboard-abc123.png"],
    // A link at `link` could make this path's `..` resolve outside the temp dir.
    ["a path that leaves through `..`", `${tmp}/link/../codex-clipboard-abc123.png`],
    ["a path that re-enters through `..`", `${tmp}/../T/codex-clipboard-abc123.png`],
    ["a path that is not a string", 7],
  ])("%s is never a copy", (_name, path) => {
    expect(clipboardCopiesIn(userMessage([image(path)]), tmp)).toEqual([]);
  });

  test.each([
    ["an item that is not a record", null],
    ["a record with no payload", { type: "event_msg" }],
    [
      "a payload that is not a completed item",
      { type: "event_msg", payload: { type: "user_message" } },
    ],
    ["a completed item that is not a record", { payload: { type: "item_completed", item: 1 } }],
    [
      "a completed item that is not a user message",
      userMessage([image(join(tmp, "codex-clipboard-a.png"))], "AgentMessage"),
    ],
    ["a user message whose content is not a list", userMessage("text")],
    ["a content part that is not a record", userMessage([null])],
  ])("%s names no copy", (_name, item) => {
    expect(clipboardCopiesIn(item, tmp)).toEqual([]);
  });
});
