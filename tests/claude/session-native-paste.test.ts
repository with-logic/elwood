/** Normalize strictly supported native Claude paste envelopes in public user activity (C-API-67). */
import { afterEach, expect, test } from "vitest";
import { resetFakes } from "./helpers.ts";
import { startActivitySession, user } from "./session-user-activity-helpers.ts";

afterEach(resetFakes);

const pasteId = "0e08"; // SHA-256 prefix of this fixture's native session ID
const provenance = { origin: "unknown", input: "pasted" };
const wrap = (body: string, id = pasteId) =>
  `\n\n<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">\n`;

test("C-API-67 authenticated Claude paste displays native body and preserves the hook", async () => {
  const { session, hook, events } = await startActivitySession();
  const nativeHookPrompts: string[] = [];
  session.on("hook", (event) => {
    if (event.hook_event_name === "UserPromptSubmit") nativeHookPrompts.push(event.prompt);
  });
  const body = "first\n    second\n<\\pasted_content>\nlast";
  const native = wrap(body);
  const invalid = [
    "ordinary prompt",
    wrap(body, "eeee"),
    `typed text${native}`,
    `${native}typed text`,
    native.replace(`</pasted_content id="${pasteId}">`, ""),
    `${native}${wrap("second paste")}`,
    wrap(wrap("nested paste", "eeee")),
    wrap(" \n"),
  ];
  try {
    for (const [i, prompt] of [native, ...invalid].entries()) {
      await hook({ hook_event_name: "UserPromptSubmit", prompt_id: `turn-${i}`, prompt });
    }
    const emptySessionEnvelope = wrap(body, "e3b0");
    await hook({
      hook_event_name: "UserPromptSubmit",
      prompt_id: "empty-session",
      session_id: "",
      prompt: emptySessionEnvelope,
    });
    invalid.push(emptySessionEnvelope);
    const messages = events.filter(({ kind }) => kind === "user_message");
    expect(nativeHookPrompts).toEqual([native, ...invalid]);
    expect(messages[0]).toMatchObject({
      kind: "user_message",
      source: "hook",
      text: body,
      nativePrompt: native,
      promptProvenance: provenance,
      raw: { prompt: native },
    });
    expect(messages.slice(1).map((event) => event.text)).toEqual(invalid);
    for (const event of messages.slice(1)) {
      expect(event).not.toHaveProperty("promptProvenance");
      expect(event).not.toHaveProperty("nativePrompt");
    }
  } finally {
    await session.teardown();
  }
});

test("C-API-67 normalizes eligible initial, pending and cached textless Claude records", async () => {
  const { session, hook, events, append } = await startActivitySession();
  const native = wrap("one\ntwo\nthree\nfour");
  const submit = (prompt_id: string) => hook({ hook_event_name: "UserPromptSubmit", prompt_id });
  const initial = "initial";
  const pending = "pending";
  const cached = "cached";
  const mixed = "mixed";
  try {
    append(user(initial, native));
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await submit(initial);
    await submit(pending);
    append(
      user(pending, [{ type: "text", text: native }]),
      user(cached, native),
      user(mixed, [{ type: "text", text: native }, { type: "image" }]),
    );
    await hook({ hook_event_name: "Stop" });
    await submit(cached);
    await submit(mixed);
    const messages = events.filter(({ kind }) => kind === "user_message");
    expect(messages).toMatchObject([
      ...[initial, pending, cached].map((turnId) => ({
        source: "transcript",
        turnId,
        text: "one\ntwo\nthree\nfour",
        nativePrompt: native,
        promptProvenance: provenance,
      })),
      { source: "transcript", turnId: mixed, text: native },
    ]);
    expect(messages[3]).not.toHaveProperty("promptProvenance");
    expect(messages[3]).not.toHaveProperty("nativePrompt");
    for (const event of messages) expect(event).not.toHaveProperty("raw");
  } finally {
    await session.teardown();
  }
});
