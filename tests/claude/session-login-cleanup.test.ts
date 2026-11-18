/** Login timeout never dismisses caller-owned dialogs (PRD §5.3, C-API-43). */
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { claudeLoginSuccess } from "../fixtures/claude-login.ts";
import { asScreen, claudePicker } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { ready } from "./login-helpers.ts";

afterEach(resetFakes);

test("C-API-43 timeout after acknowledgement leaves a caller-opened model dialog untouched", async () => {
  const cwd = tempDir();
  installFakes();
  const session = await startClaude({ cwd });
  await ready(cwd, session);
  const rejected = expect(
    session.login({ provideCode: () => "unused", timeoutMs: 1_000 }),
  ).rejects.toMatchObject({ code: "login_timeout" });
  await expect.poll(() => ptys[0]!.writes.filter((write) => write === "\r").length).toBe(1);
  ptys[0]!.emitData(asScreen(claudeLoginSuccess));
  await expect.poll(() => ptys[0]!.writes.filter((write) => write === "\r").length).toBe(2);
  await session.sendKeys("/model\r");
  ptys[0]!.emitData(asScreen(claudePicker));
  await rejected;
  expect(ptys[0]!.writes).not.toContain("\u001b");
  expect(session.terminal.snapshot().text).toContain("Select model");
});
