/** Native recovery reads and queued admission never keep an idle host alive (C-LIFE-10). */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import type { PsRunOptions } from "../../src/runtime/shutdown/process-table.ts";
import { killIfCommandHas, pidExists } from "../helpers/process-liveness.ts";
import { tempDir } from "../helpers/tmp.ts";

const SHUTDOWN = resolve(import.meta.dirname, "../../src/runtime/shutdown");
const OPTIONS = {
  timeout: 5_000,
  maxBuffer: 1024,
  killSignal: "SIGKILL",
  env: {},
} satisfies PsRunOptions;
const READER = `
const fs = require("node:fs");
fs.writeFileSync(process.argv[1]+"/pid",String(process.pid));
setInterval(()=>{},1000);
`;
const PENDING = `
const {createUnreferencedProcessTableReader, runFileUnreferencedNative} = await import(process.env.SHUTDOWN+"/unreferenced-read.ts");
const fs = await import("node:fs");
const keepAlive = setInterval(()=>{},1000);
const read = createUnreferencedProcessTableReader((_,args,options)=>runFileUnreferencedNative(process.execPath,["-e",process.env.READER,process.env.MARKER],options));
void read(5000).catch(()=>{});
while (!fs.existsSync(process.env.MARKER+"/pid")) await new Promise(resolve=>setTimeout(resolve,5));
console.log("ready\\npending");
clearInterval(keepAlive);
`;
const COALESCING = `
const {coalesceBeforeNativeAdmission} = await import(process.env.SHUTDOWN+"/coalesce-before-native-admission.ts");
const read = coalesceBeforeNativeAdmission(()=>{console.log("unexpected launch");return new Promise(()=>{});},{ref:false});
void read(5000).catch(()=>{});
console.log("ready\\nqueued");
`;
const FOREGROUND = `
const {coalesceBeforeNativeAdmission} = await import(process.env.SHUTDOWN+"/coalesce-before-native-admission.ts");
const {runFileUnreferencedNative} = await import(process.env.SHUTDOWN+"/unreferenced-read.ts");
const {psRunOptions} = await import(process.env.SHUTDOWN+"/process-table.ts");
const read = coalesceBeforeNativeAdmission(timeout=>runFileUnreferencedNative(process.execPath,["-e","setTimeout(()=>{},150)"],psRunOptions(timeout)));
void read(5000).then(()=>console.log("foreground completed"));
console.log("ready");
`;
const ADMISSION = `
const {admitNativeProcessRead} = await import(process.env.SHUTDOWN+"/native-read-admission.ts");
for(let n=0;n<2;n++) void admitNativeProcessRead(5000,()=>new Promise(()=>{}));
void admitNativeProcessRead(5000,()=>Promise.resolve(),{ref:false}).catch(()=>{});
console.log("ready\\nqueued");
`;
const QUEUED = `
const {admitNativeProcessRead} = await import(process.env.SHUTDOWN+"/native-read-admission.ts");
const {runFileUnreferenced} = await import(process.env.SHUTDOWN+"/unreferenced-read.ts");
for(let n=0;n<2;n++) void admitNativeProcessRead(5000,()=>new Promise(()=>{}));
void runFileUnreferenced(process.execPath,["-e",process.env.READER,process.env.MARKER],JSON.parse(process.env.OPTIONS)).catch(()=>{});
console.log("ready\\nqueued");
`;

const QUEUED_COALESCED = `
const {admitNativeProcessRead} = await import(process.env.SHUTDOWN+"/native-read-admission.ts");
const {createUnreferencedProcessTableReader} = await import(process.env.SHUTDOWN+"/unreferenced-read.ts");
for(let n=0;n<2;n++) void admitNativeProcessRead(5000,()=>new Promise(()=>{}));
const read = createUnreferencedProcessTableReader(()=>{console.log("unexpected launch");return Promise.resolve({stdout:""});});
void read(5000).catch(()=>{});
await new Promise(resolve=>setImmediate(resolve));
console.log("ready\\nqueued");
`;

const RECOVERY = `
const {reapInBackground} = await import(process.env.SHUTDOWN+"/detached-sweep/background.ts");
const {DescendantRecord} = await import(process.env.SHUTDOWN+"/detached-sweep/record.ts");
const record = new DescendantRecord();
const leader = {pid:10000001,pgid:10000001,ppid:1,zombie:false,stopped:false,startedAt:"Fri Jan 1 00:00:00 1960",name:"sh",shared:false};
record.observeFirst([leader],leader.pid,Date.now());
record.observe([leader,{...leader,pid:10000002,pgid:10000002,ppid:leader.pid}],leader.pid,Date.now());
reapInBackground(record,{
  listProcesses:async()=>{console.log("ready\\nqueued");throw new Error("unreadable");},
  stopGroup:()=>{},killGroup:()=>{},continueGroup:()=>{}
},attempt=>attempt());
`;
const CONFIRMATION = `
const {reapInBackground,BACKGROUND_REAP_RETRY_WINDOW_MS} = await import(process.env.SHUTDOWN+"/detached-sweep/background.ts");
const {DescendantRecord} = await import(process.env.SHUTDOWN+"/detached-sweep/record.ts");
const {SerialDetachedSweepQueue} = await import(process.env.SHUTDOWN+"/reap-queue.ts");
const record = new DescendantRecord();
const leader = {pid:10000001,pgid:10000001,ppid:1,zombie:false,stopped:false,startedAt:"Fri Jan 1 00:00:00 1960",name:"sh",shared:false};
const child = {...leader,pid:10000002,pgid:10000002,ppid:leader.pid};
record.observeFirst([leader],leader.pid,Date.now());
record.observe([leader,child],leader.pid);
let clock = 0;
Object.defineProperty(performance,"now",{value:()=>clock});
const queue = new SerialDetachedSweepQueue();
const ops = {listProcesses:()=>new Promise(resolve=>setTimeout(()=>resolve([child]),500).unref()),stopGroup:()=>{},killGroup:()=>{},continueGroup:()=>{}};
const recovery = reapInBackground(record,ops,attempt=>queue.run(attempt),{...ops,listProcesses:async()=>[]});
clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
console.log("ready");
void recovery.confirm().then(()=>console.log("foreground completed"));
`;

test.each([
  {
    name: "unstarted coalescing",
    source: COALESCING,
    expectedStdout: "ready\nqueued\n",
    hasChildMarker: false,
  },
  {
    name: "foreground read",
    source: FOREGROUND,
    expectedStdout: "ready\nforeground completed\n",
    hasChildMarker: false,
  },
  {
    name: "queued admission",
    source: ADMISSION,
    expectedStdout: "ready\nqueued\n",
    hasChildMarker: false,
  },
  {
    name: "coalesced native read",
    source: PENDING,
    expectedStdout: "ready\npending\n",
    hasChildMarker: true,
  },
  {
    name: "queued native read",
    source: QUEUED,
    expectedStdout: "ready\nqueued\n",
    hasChildMarker: false,
  },
  {
    name: "queued coalesced read",
    source: QUEUED_COALESCED,
    expectedStdout: "ready\nqueued\n",
    hasChildMarker: false,
  },
  {
    name: "retained retry timer",
    source: RECOVERY,
    expectedStdout: "ready\nqueued\n",
    hasChildMarker: false,
  },
  {
    name: "foreground confirmation behind an unreferenced read",
    source: CONFIRMATION,
    expectedStdout: "ready\nforeground completed\n",
    hasChildMarker: false,
  },
])("C-LIFE-10 host lifetime follows the references during $name", async ({
  source,
  expectedStdout,
  hasChildMarker,
}) => {
  const marker = tempDir("elwood-unreferenced-read-");
  const host = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", source], {
    env: { ...process.env, SHUTDOWN, MARKER: marker, READER, OPTIONS: JSON.stringify(OPTIONS) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(host, "close");
  let deadline: NodeJS.Timeout | undefined;
  let stderr = "";
  let stdout = "";
  host.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  host.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    await vi.waitFor(() => expect(stdout.startsWith("ready\n")).toBe(true), { timeout: 2_000 });
    await expect(
      Promise.race([
        exited,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("read held idle host")), 1500);
        }),
      ]),
    ).resolves.toEqual([0, null]);
    expect(stderr).toBe("");
    expect(stdout).toBe(expectedStdout);
    const pidFile = join(marker, "pid");
    expect(existsSync(pidFile)).toBe(hasChildMarker);
    if (hasChildMarker) {
      expect(pidExists(Number(readFileSync(pidFile, "utf8")))).toBe(true);
    }
  } finally {
    clearTimeout(deadline);
    if (host.exitCode === null) host.kill("SIGKILL");
    await exited;
    const pidFile = join(marker, "pid");
    if (existsSync(pidFile)) killIfCommandHas(Number(readFileSync(pidFile, "utf8")), marker);
  }
});
