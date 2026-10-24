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
node --expose-gc --no-warnings scripts/performance/fleet/index.ts
```

This probe starts 50 production runtimes, alternating Claude and Codex, with
synthetic PTY producers. Dependency seams model macOS even on other hosts; this
does not test native-agent support on those hosts. It exercises real local hook
sockets, transcript watchers, frame observers, public snapshots and cleanup without
launching agent CLIs or making model calls. Each session receives 80 full-screen redraws at
120 columns by 40 rows, then 1,200 scrolling lines. Assertions check all
15,155,250 output bytes, 500 transcript activities and final viewport markers.
The process reports setup separately, a two-second idle CPU sample, active CPU,
wall time, event-loop delay, live memory after GC and resource cleanup.
For a quick smoke run, set `ELWOOD_BENCH_SESSIONS=2 ELWOOD_BENCH_ROUNDS=2`.

### October 24, 2026: shared completed-frame text

Three alternating reference/candidate pairs used the same worktree, v2 probe
and Node 26.3.1 on the development Mac. Both sides used the benchmark from
`f6e4406c`; the reference restored runtime files from release `ba8b634e`
(0.2.0), while the candidate used the runtime at `f6e4406c`.
Values below are medians, not guarantees. Host activity changed absolute
timings substantially between measurement windows; compare matched pairs.

| Parent-process metric | Reference | Shared frame | Change |
|---|---:|---:|---:|
| Active CPU | 1,177.071 ms | 1,043.927 ms | −11.3% |
| Idle CPU over two seconds | 20.955 ms | 22.113 ms | +1.158 ms; variable |
| Live JS heap | 52.828 MiB | 53.084 MiB | +0.5% |

Active CPU samples were 1,176.453 / 1,177.071 / 1,195.298 ms before and
1,043.927 / 1,045.998 / 1,031.162 ms after. Every v2 run passed per-session
byte/activity attribution, final viewport markers and resource-count checks.
The probe awaits teardown of every session, removing private socket homes before
its shared root. Regression tests verify filesystem cleanup, rejection ordering,
extra handles of an existing type and offsetting per-session accounting gaps.
Idle samples ranged from 20.275–25.492 ms before and 16.285–23.858 ms after;
no idle optimization is claimed. The CPU reduction is below the initial 15%
estimate, with effectively unchanged live heap.

The change removes a second viewport conversion in foreign-picker observation
while preserving fresh public snapshots and input-boundary reads. Raw xterm
writes, writeln and reset invalidate private cached text; disposal restores the
original methods. Regression tests fail with the change removed, including a
raw write in an owned parser drain, writeln's synchronous parse after user input
and method restoration on disposal.

An earlier v1 comparison measured 10.3% lower CPU. Its aggregate assertions
did not establish per-session completeness, same-type handle counts or socket-home
removal; the v2 comparison above supersedes that result.

These measurements exclude browser rendering and agent-process memory/CPU.
The probe's final screen assertions and 500 activity count protect this workload;
they do not establish correctness for every native dialog. The repository's
conformance suite remains the merge gate.

## Consumer memory and rendering budgets

Elwood's headless xterm retains 1,000 history lines by default. Consumers that
retain their own raw terminal history can opt out of headless scrollback through
the existing advanced xterm handle:

```ts
const session = await startCodex({ cwd });
session.terminal.xterm.options.scrollback = 0;
```

The same setting applies to Claude sessions. Apply it at session creation,
before sustained output. This discards headless scrollback and changes what
xterm can recover/reflow on scrolling and resizing; choose a small nonzero
budget if that history is needed. It does not change the consumer's own replay
store or browser terminal's independent scrollback setting.

Three alternating default/zero-history runs of the fixed 50-session workload
on Node 26.3.1, commit `f6e4406c`, measured the following medians after
1,200 scrolling lines per session. The experimental preload changed only xterm
constructor scrollback; all byte, transcript, viewport and cleanup assertions
passed. A separate two-adapter smoke used the public setter above and verified
zero history rows after scrolling. This is a configuration comparison, not a
runtime default change.

| Parent-process memory | Default 1,000 lines | Zero history |
|---|---:|---:|
| Live JS heap | 53.080 MiB | 38.977 MiB |
| External memory | 81.017 MiB | 13.065 MiB |
| Process RSS | 318.766 MiB | 231.484 MiB |

JS heap samples ranged from 53.078–53.080 MiB at the default budget and
34.650–38.987 MiB at zero history. History, dimensions, GC and host activity
affect these values. CPU and
idle timing varied enough that no CPU benefit is claimed for this setting.

For many-session consumers:

- Feed all ordered `terminal:data` bytes to the consumer's terminal/history
  pipeline; batch browser writes without dropping bytes or ANSI boundaries.
- Keep only visible terminals rendering. Bound browser scrollback independently
  and avoid polling public snapshots for every hidden session. Public snapshots
  deliberately perform a fresh viewport read.
- Use normalized activity for chat/progress updates. Append to a bounded store
  and batch UI updates instead of rerendering all terminal history per event.
- Measure Elwood parent CPU separately from agent child processes and the UI
  renderer. Browser refresh/history costs do not appear in the headless probe.

The update-dialog prefilter prototype reduced active CPU by 3.8% in its matched
window, below this investigation's 5% decision threshold, and was not retained.
Fifty idle sessions used roughly 20 ms of parent CPU per two seconds; the
measurements did not justify a polling rewrite. The
[terminal engine assessment](performance/terminal-engines.md) records the
Ghostty prototype and the compatibility requirements for a replacement.

The fleet probe dispatches authenticated local hook requests directly; it does
not launch the generated hook-bridge subprocess for each request. Bridge-process
startup/CPU, agent processes and the browser need separate measurements. The
parent-process results do not establish a whole-system scaling guarantee.
