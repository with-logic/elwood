/** Claude only repairs a blank prompt from a directly matched committed user record (PRD §5.4). */
import { afterEach, expect, test } from "vitest";
import { ptys, resetFakes } from "./helpers.ts";
import { startActivitySession, user } from "./session-user-activity-helpers.ts";

afterEach(resetFakes);

test("C-API-63 repairs an earlier blank hook once the matched text commits", async () => {
  const { session, hook, events, append } = await startActivitySession();
  const submit = (prompt_id: string, prompt?: string) =>
    hook({
      hook_event_name: "UserPromptSubmit",
      prompt_id,
      ...(prompt === undefined ? {} : { prompt }),
    });
  try {
    append(user("historical", "old conversation"), user("baseline", "unmatched prior turn"));
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await session.sendPrompt("submitted from API");
    expect(await submit("first")).toMatchObject({ exitCode: 0 });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "hook", hookEventName: "UserPromptSubmit", turnId: "first" }),
    );
    expect(events.filter(({ kind }) => kind === "user_message")).toEqual([]);
    await submit("historical", "\n");
    await submit("next", "neighbor hook prompt");
    append(
      user("wrong", "different transcript prompt"),
      user("first", [{ type: "tool_result", tool_use_id: "tool", content: "tool output" }]),
      user("first", [{ type: "text", text: "submitted from API" }]),
      user("first", "duplicate record"),
      user("next", "neighbor hook prompt"),
    );
    await hook({ hook_event_name: "Stop" });
    await submit("first", "submitted from API");
    expect(events.filter(({ kind }) => kind === "user_message")).toMatchObject([
      { text: "neighbor hook prompt", turnId: "next", source: "hook" },
      { text: "submitted from API", turnId: "first", source: "transcript" },
    ]);
  } finally {
    await session.teardown();
  }
});

test.each([
  "live",
  "after exit",
])("C-API-63 a hook-scoped recovered prompt rejection is handled %s", async (timing) => {
  const { session, hook, events, append } = await startActivitySession();
  const pending = Promise.withResolvers<void>();
  const warningCodes: string[] = [];
  session.on("warning", ({ code }) => warningCodes.push(code));
  session.on("activity", (event) =>
    event.kind === "user_message" && event.source === "transcript" ? pending.promise : undefined,
  );
  try {
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "first" });
    append(user("first", "native prompt"));
    await hook({ hook_event_name: "Stop" });
    expect(events.filter(({ kind }) => kind === "user_message")).toHaveLength(1);
    if (timing === "after exit") {
      const exit = new Promise<void>((resolve) => session.on("terminal:exit", () => resolve()));
      ptys.at(-1)!.emitExit({ exitCode: 0 });
      await exit;
    }
    pending.reject(new Error("listener failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const expected = timing === "live" ? ["hook_observer_failed"] : [];
    expect(warningCodes).toEqual(expected);
    expect(events.filter(({ kind }) => kind === "warning").map(({ label }) => label)).toEqual(
      expected,
    );
  } finally {
    await session.teardown();
  }
});

test("C-API-63 recovered activity omits the raw transcript record", async () => {
  const { session, hook, events, append } = await startActivitySession();
  try {
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "first" });
    append(user("first", "native prompt"));
    await hook({ hook_event_name: "Stop" });
    const recovered = events.filter(({ kind }) => kind === "user_message");
    expect(recovered).toMatchObject([{ text: "native prompt", turnId: "first" }]);
    expect(recovered[0]).not.toHaveProperty("raw");
    expect(events.filter(({ kind }) => kind === "assistant_message")).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-API-63 a blank hook recovers its exact committed initial prompt once", async () => {
  const { session, hook, events, append } = await startActivitySession();
  try {
    append(user("historical", "another turn"), user("first", "native pasted prompt"));
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    const submit = () =>
      hook({ hook_event_name: "UserPromptSubmit", prompt_id: "first", prompt: "" });
    const recovered = () => events.filter(({ kind }) => kind === "user_message");
    expect(await submit()).toMatchObject({ exitCode: 0 });
    expect(recovered()).toMatchObject([
      { text: "native pasted prompt", source: "transcript", turnId: "first" },
    ]);
    expect(await submit()).toMatchObject({ exitCode: 0 });
    expect(recovered()).toHaveLength(1);
  } finally {
    await session.teardown();
  }
});

test("C-API-63 an older initial prompt cannot match or leave the lookup open", async () => {
  const { session, hook, events, append } = await startActivitySession();
  try {
    append(user("older", "historical prompt"), user("latest", "newest native prompt"));
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    for (const prompt_id of ["older", "latest"]) {
      expect(
        await hook({ hook_event_name: "UserPromptSubmit", prompt_id, prompt: "" }),
      ).toMatchObject({
        exitCode: 0,
      });
      expect(events.filter(({ kind }) => kind === "user_message")).toEqual([]);
    }
  } finally {
    await session.teardown();
  }
});
