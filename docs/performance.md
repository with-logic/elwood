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
