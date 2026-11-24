/** Proactive Claude renewal notices through the live API (PRD §5.7, C-CLAUDE-23). */
import { afterEach, expect, test } from "vitest";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { viewTerminalHistory } from "../helpers/live-buffer-fixture.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { FakePty, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-CLAUDE-23 observes renewal on resume without replaying to late listeners", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-resume",
    cwd,
    prompt: "existing conversation",
  });
  await session.stop();
  setPtyFactoryForTests((options) => {
    const pty = new FakePty(options);
    ptys.push(pty);
    queueMicrotask(() => pty.emitData(notice(3)));
    return pty;
  });
  const resumed = await resumeClaude({ cwd, elwoodSessionId: session.elwoodSessionId });
  const warnings: unknown[] = [];
  resumed.on("warning", (event) => warnings.push(event));
  await expect.poll(() => warnings.length).toBe(1);
  expect(warnings[0]).toMatchObject({
    code: "login_expiring",
    expiresInDays: 3,
    elwoodSessionId: resumed.elwoodSessionId,
  });
  const late: unknown[] = [];
  resumed.on("warning", (event) => late.push(event));
  ptys[1]!.emitData(notice(3));
  await resumed.terminal.settled();
  expect(late).toEqual([]);
  ptys[1]!.emitData(notice(2));
  await expect.poll(() => late).toMatchObject([{ code: "login_expiring", expiresInDays: 2 }]);
});

const notice = (days: number) =>
  asScreen(`Claude Code v2.1.305\n⚠ Your login expires in ${days} days · run /login to renew`);

test.each([
  "⏸ manual mode on",
  "⏸ manual mode on · ? for shortcuts",
])("C-CLAUDE-23 a quoted footer needs a live native composer cursor (%s)", async (manualFooter) => {
  installFakes();
  const session = await startClaude({ cwd: tempDir() });
  const warnings: unknown[] = [];
  session.on("warning", (event) => warnings.push(event));
  const footer = `───\n❯ \n───\n  ${manualFooter}\nYour login expires in 1 day · run /login to renew`;
  ptys[0]!.emitData(asScreen(`⏺ Quoted footer:\n${footer}`));
  await session.terminal.settled();
  expect(warnings).toEqual([]);
  ptys[0]!.emitData(`${asScreen(footer)}\u001b[?25h\u001b[2;3H`);
  await expect.poll(() => warnings).toMatchObject([{ code: "login_expiring", expiresInDays: 1 }]);
});

test("C-CLAUDE-23 delivers pre-return renewal notices and matching activity without blocking", async () => {
  installFakes();
  setPtyFactoryForTests((options) => {
    const pty = new FakePty(options);
    ptys.push(pty);
    queueMicrotask(() => pty.emitData(notice(3)));
    return pty;
  });
  const session = await startClaude({ cwd: tempDir() });
  const warnings: unknown[] = [];
  const activities: unknown[] = [];
  session.on("warning", (event) => warnings.push(event));
  session.on("activity", (event) => {
    if (event.kind === "warning") activities.push(event.raw);
  });
  await expect
    .poll(() => warnings)
    .toContainEqual({
      elwoodSessionId: session.elwoodSessionId,
      agent: "claude",
      source: "terminal",
      code: "login_expiring",
      severity: "warning",
      expiresInDays: 3,
      recoveryCommand: "/login",
      message: "Claude's login expires in 3 days. Run /login (or session.login()) to renew.",
      raw: "login_expiring days=3 recovery=/login",
    });
  expect(activities).toEqual(warnings);
  expect(ptys[0]!.writes).not.toContain("/login");
  expect(ptys[0]!.killSignals).toEqual([]);
});

test("C-CLAUDE-23 countdowns warn once each despite redraws, clearing and throwing listeners", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "InstructionsLoaded",
    session_id: "claude-1",
    cwd,
    file_path: `${cwd}/CLAUDE.md`,
    memory_type: "Project",
    load_reason: "session_start",
  });
  session.on("warning", () => {
    throw new Error("listener");
  });
  const warnings: unknown[] = [];
  session.on("warning", (event) => warnings.push(event));
  for (const screen of [notice(3), notice(3), asScreen("clear"), notice(3), notice(2)]) {
    ptys[0]!.emitData(screen);
    await session.terminal.settled();
  }
  await expect.poll(() => warnings.length).toBe(2);
  expect(warnings).toMatchObject([
    { code: "login_expiring", expiresInDays: 3 },
    { code: "login_expiring", expiresInDays: 2 },
  ]);
  expect(session.status).toBe("ready");
  expect(ptys[0]!.writes.some((write) => write.includes("/login"))).toBe(false);
  await session.sendMessage("continue after renewal notice");
  expect(ptys[0]!.writes).toContain("\u001b[200~continue after renewal notice\u001b[201~");
});

test("C-CLAUDE-23 wrapped notices above the native composer preserve its cursor row", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir() });
  const warnings: unknown[] = [];
  session.on("warning", (event) => warnings.push(event));
  const screen =
    "Claude Code v2.1.305\n⚠ Your login expires in\n3 days · run /login to renew\n───\n❯ \n───\n  ⏸ manual mode on\nYour login expires in\n1 day · run /login to renew";
  ptys[0]!.emitData(`${asScreen(screen)}\u001b[?25h\u001b[5;3H`);
  await expect.poll(() => warnings).toMatchObject([{ code: "login_expiring", expiresInDays: 1 }]);
});

test.each([
  ["hardware", "\u001b[?25h\u001b[2;3H"],
  ["drawn", "\u001b[?25l\u001b[2;3H\u001b[7m \u001b[27m\u001b[2;3H"],
])("C-CLAUDE-23 %s composer cursor proves a renewal footer while viewing history", async (_kind, cursor) => {
  installFakes();
  const session = await startClaude({ cwd: tempDir() });
  const warnings: unknown[] = [];
  session.on("warning", (event) => warnings.push(event));
  try {
    const { isScrolled, paint } = await viewTerminalHistory(session.terminal, ptys[0]!);
    await paint("❯ \r\n");
    await paint(
      `───\r\n❯ \r\n───\r\n  ⏸ manual mode on\r\nYour login expires in 1 day · run /login to renew${cursor}`,
    );
    expect(session.terminal.xterm.buffer.active.baseY).toBeGreaterThan(0);
    expect(isScrolled()).toBe(true);
    expect(warnings).toMatchObject([{ code: "login_expiring", expiresInDays: 1 }]);
  } finally {
    await session.stop();
  }
});
