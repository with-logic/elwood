/** Child-host fixtures for pending unreferenced reads and retry timers (C-LIFE-14). */
export const PENDING_READ_HOST = `
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const { settleUnreferenced } = await import(process.env.SHUTDOWN + "/unreferenced-read.ts");
const running = promisify(execFile)(process.execPath, ["-e", "setInterval(() => {}, 1000)", process.env.MARKER]);
settleUnreferenced(running, 20000, "SIGKILL").catch(() => {});
process.stdout.write("pending " + running.child.pid + "\\n");
`;

export const WAITING_RETRY_HOST = `
const { DescendantRecord } = await import(process.env.SHUTDOWN + "/detached-sweep/record.ts");
const { reapInBackground } = await import(process.env.SHUTDOWN + "/detached-sweep/background.ts");
const { UNREAD } = await import(process.env.SHUTDOWN + "/process-table.ts");
const leader = { ...UNREAD, pid: 999998, ppid: 1, pgid: 999998, startedAt: "Sun Oct 25 22:00:00 2026" };
const hook = { ...leader, pid: 999997, ppid: leader.pid, pgid: 999997 };
const record = new DescendantRecord();
record.observe([leader, hook], leader.pid);
let stopped = false;
let killed = false;
reapInBackground(record, {
  stopGroup: () => void (stopped = true), killGroup: () => void (killed = true), continueGroup: () => {},
  listProcesses: () => Promise.resolve(killed ? [] : [{ ...hook, ppid: 1, stopped }]),
});
process.stdout.write("reaping\\n");
`;
