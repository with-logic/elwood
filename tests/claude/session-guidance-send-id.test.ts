/**
 * Guidance written while Claude's turn runs claims its caller ID through the hook Claude fires
 * under the running turn's prompt ID, with the working composer as its empty-input proof
 * (PRD §5.4, C-API-71). Replays the 2.1.332 captures through the real session wiring.
 */
import { afterEach, expect, onTestFinished, test } from "vitest";
import { nativeFrameOutput, readNativeInputFrame } from "../fixtures/native-input-frame.ts";
import { resetFakes } from "./helpers.ts";
import { startPromptActivitySession } from "./session-user-activity-helpers.ts";

afterEach(resetFakes);

const working = (name: string) =>
  nativeFrameOutput(
    readNativeInputFrame(
      new URL(`../fixtures/claude-2.1.332/working-composer/${name}.json`, import.meta.url),
    ),
  );

async function runningTurn() {
  const activity = await startPromptActivitySession();
  onTestFinished(() => activity.session.teardown());
  await activity.session.sendMessage("Run the tool.", { sendId: "turn" });
  await activity.submit("Run the tool.", "running");
  const paint = async (name: string) => {
    activity.pty.emitData(working(name));
    await activity.session.terminal.settled();
  };
  return { ...activity, paint };
}

test("C-API-71 guidance written under Claude's working composer claims its caller ID", async () => {
  const { session, paint, submit, messages } = await runningTurn();
  await paint("working-empty");
  await session.sendGuidance("Note one.", { sendId: "guidance-1" });
  await submit("Note one.", "running");
  await paint("queued-messages");
  await session.sendGuidance("Note two.", { sendId: "guidance-2" });
  await submit("Note two.", "running");
  expect(messages().map((message) => [message.text, message.sendId, message.turnId])).toEqual([
    ["Run the tool.", "turn", "running"],
    ["Note one.", "guidance-1", "running"],
    ["Note two.", "guidance-2", "running"],
  ]);
});

test("C-API-71 a message under the running turn's prompt ID claims no caller ID", async () => {
  const { session, paint, submit, messages } = await runningTurn();
  await paint("working-empty");
  await session.sendPrompt("Not guidance.", { sendId: "prompt" });
  await submit("Not guidance.", "running");
  expect(messages()[1]).toMatchObject({ text: "Not guidance.", turnId: "running" });
  expect(messages()[1]).not.toHaveProperty("sendId");
});
