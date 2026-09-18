/**
 * Every queued writer holds on a model dialog that outlived its cleanup, `/login`
 * included (PRD §5.3, C-API-43, C-API-55).
 */

import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { asScreen, claudePicker } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { ready, succeedAndRecover } from "./login-helpers.ts";

afterEach(resetFakes);

test("C-API-55 login and a queued message hold while a model dialog survives cleanup", async () => {
  const cwd = tempDir();
  installFakes();
  const session = await startClaude({ cwd });
  await ready(cwd, session);
  const pty = ptys[0]!;
  const failed = session.setModel("no-such-model", { timeoutMs: 4_000 }).catch((error) => error);
  await expect.poll(() => pty.writes.includes("/model")).toBe(true);
  // This CLI ignores Escape: the picker is still open when the one-second cleanup ends.
  pty.emitData(asScreen(claudePicker));
  expect(await failed).toMatchObject({ code: "model_automation_failed" });
  const written = pty.writes.length;
  const login = session.login({ provideCode: () => "x", timeoutMs: 10_000 });
  const message = session.sendMessage("after the picker");
  await new Promise((resolve) => setTimeout(resolve, 400));
  // Enter on the residual picker would persist the highlighted model as the user default.
  expect(pty.writes.slice(written)).toEqual([]);
  // A human dismisses the picker; the held login then runs, and the message after it.
  pty.emitData(asScreen("❯ "));
  await expect.poll(() => pty.writes.includes("/login")).toBe(true);
  pty.emitData(asScreen("Select login method:\n Claude account with subscription"));
  await succeedAndRecover(cwd, session);
  await login;
  await message;
  expect(pty.writes.indexOf("/login")).toBeGreaterThan(written - 1);
}, 20_000);
