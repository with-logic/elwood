# Performance checks

Elwood's parent process renders terminal output, classifies frames, retains a
bounded replay buffer, and watches transcripts for each session. Native Claude
and Codex processes consume additional resources outside this process.

## Repeatable terminal load

Run these from the repository root after `npm ci`, using Node 24 or newer:

```sh
ELWOOD_BENCH_AGENT=claude node --expose-gc --no-warnings scripts/performance/terminal.ts 8 1 8 32
ELWOOD_BENCH_AGENT=codex node --expose-gc --no-warnings scripts/performance/terminal.ts 8 1 8 32
```

Each child writes 8 MiB through a real PTY. The probe checks byte counts and a
final rendered marker, then reports elapsed time, memory, event-loop delay,
pending output, and resources remaining after cleanup. The selected observer
runs the production startup-prompt, screen-fact, turn, attention, and replay
code. Omit `ELWOOD_BENCH_AGENT` to measure rendering and snapshots alone.

This is a synthetic output burst. It does not launch agent CLIs, make model
requests, exercise hook or transcript traffic, or measure child-process memory.
Use it to detect regressions in Elwood's output processing; real workloads need
their own measurements.

### September 16, 2026 baseline

Measured on the development Mac with Node 24.7.0. Results vary with machine and
concurrent workload; these are observations, not performance guarantees.

| Observer | Sessions | Total output | Elapsed | Peak parent RSS | Event-loop p99 / max |
|---|---:|---:|---:|---:|---:|
| Claude | 1 | 8 MiB | 0.185 s | 110 MiB | 11.3 / 11.3 ms |
| Claude | 8 | 64 MiB | 0.969 s | 240 MiB | 14.4 / 16.0 ms |
| Claude | 32 | 256 MiB | 7.608 s | 363 MiB | 26.2 / 31.9 ms |
| Codex | 1 | 8 MiB | 0.243 s | 117 MiB | 19.5 / 19.5 ms |
| Codex | 8 | 64 MiB | 1.537 s | 248 MiB | 17.4 / 23.4 ms |
| Codex | 32 | 256 MiB | 9.270 s | 364 MiB | 23.9 / 42.3 ms |

At 32 sessions, final rendering finished within 10 ms of child exit. Neither
run retained PTY resources after cleanup, and post-GC heap usage did not increase
over that trial's starting heap. The remaining `PipeWrap` was the probe's stdout.

Before output batching, the snapshot-only probe took 14.497 s for one 8 MiB
session, queued about 8.19 MiB, and spent 14.19 s rendering after child exit.
The corresponding post-fix trial took 0.544 s. These two trials used the same
snapshot-only workload; the table above also includes production frame observers.

A separate ten-second idle probe used 128 real empty transcript files, split
evenly between Claude and Codex watchers at their default polling intervals. It
used 97.9 ms of CPU time (about 0.98% of one core), with 19.0 ms p99 event-loop
delay. It reported no errors, no retained heap increase, and no active resources
after closing the watchers. This measures idle polling, not transcript parsing
under active output.

## Bounds and regression coverage

- Adjacent PTY output is batched for at most 4 ms or 64 KiB, preserving order and
  content. Renderer observations occur at batch boundaries.
- Real PTYs pause at 1 MiB of pending output and resume below 512 KiB. An already
  delivered chunk can exceed the threshold. Custom PTY factories must provide
  flow control to receive this backpressure.
- Runtime cleanup gives received output up to one second to render before
  disposal. Process exit and reaping remain immediate; direct terminal disposal
  discards pending output immediately.
- Tests cover batch ordering, Unicode/ANSI boundaries, slow-renderer
  backpressure, disposal, final output on exit, and cancellation of late
  readiness timers.

Re-run the probe after changes to rendering, frame classification, replay,
transcript polling, or cleanup. Compare output correctness and cleanup as well
as throughput, memory, and event-loop delay.

## Fifty-session runtime workload

```sh
node --expose-gc --no-warnings scripts/performance/fleet.ts
```

This probe starts 50 production runtimes, alternating Claude and Codex, with
synthetic PTY producers. It exercises real local hook sockets, transcript
watchers, frame observers, public snapshots and cleanup without launching agent
CLIs or making model calls. Each session receives 80 full-screen redraws at
120 columns by 40 rows, then 1,200 scrolling lines. Assertions check all
15,155,250 output bytes, 500 transcript activities and final viewport markers.
The process reports setup separately, a two-second idle CPU sample, active CPU,
wall time, event-loop delay, live memory after GC and resource cleanup.
For a quick smoke run, set `ELWOOD_BENCH_SESSIONS=2 ELWOOD_BENCH_ROUNDS=2`.

### October 24, 2026: shared completed-frame text

Three alternating reference/candidate pairs used the same worktree, workload
and Node 26.3.1 on the development Mac. The reference is commit `bbda211e`
(the 0.2.0 runtime plus this probe); the candidate is `34ab7dd5`.
Values below are medians, not guarantees. Host activity changed absolute
timings substantially between measurement windows; compare matched pairs.

| Parent-process metric | Reference | Shared frame | Change |
|---|---:|---:|---:|
| Active CPU | 1,165.772 ms | 1,045.619 ms | −10.3% |
| Idle CPU over two seconds | 20.819 ms | 20.215 ms | Within noise |
| Live JS heap | 53.262 MiB | 53.306 MiB | Within noise |

Active CPU samples were 1,165.772 / 1,174.442 / 1,151.372 ms before and
1,047.047 / 1,030.526 / 1,045.619 ms after. Every run passed byte, transcript,
viewport and resource checks. The measured reduction is smaller than the
initial 15% estimate. It removes a second viewport conversion in foreign-picker
observation while preserving fresh public snapshots and input-boundary reads.
Raw xterm writes, writeln and reset invalidate private cached text. Regression
tests fail with the change removed, including a raw write in an owned parser
drain and writeln's synchronous parse after user input.

These measurements exclude browser rendering and agent-process memory/CPU.
The probe's final screen assertions and 500 activity count protect this workload;
they do not establish correctness for every native dialog. The repository's
conformance suite remains the merge gate.
