# Terminal engine assessment — October 24, 2026

Keep xterm for the current optimization. A private Ghostty WASM probe showed
a useful parser/formatter CPU reduction, but does not yet implement Elwood's
terminal contract. Replacing the engine requires an explicit API migration: the
public `terminal.xterm` exposes the complete headless xterm Terminal, including proposed
APIs. Running both engines would retain both parsing and buffer costs.

## Probe scope and provenance

The experiment instantiated the official full `ghostty-vt.wasm` in Node 26.3.1
with one WASM instance containing 50 terminals. Both engines parsed the same
80 full-screen redraws at 120 columns by 40 rows. The snapshot variant decoded
Ghostty's plain formatter output and checked final round markers. UTF-8 copy
and decoding were included. This was a standalone diagnostic, not the full
Elwood runtime workload; no hook/watch/classification or browser costs were
included. The trace did not fill scrollback.

The official nightly release was associated with source revision
`22f100c6367045bb5fc86172f837047dee2f7670`, library `0.1.0-dev`.
The 1,189,559-byte WASM SHA-256 was
`e23598cefe95b42d441221a45d22d435c9c1915bca7475fe735e7617eac1a0d1`.
Its embedded type metadata had a null commit field: the binary hash pins the
measured bytes; the source association comes from release metadata. The `tip`
URL moves and must not be treated as an immutable version. No dependency or
WASM binary was added to Elwood.

Sources: [official release](https://github.com/ghostty-org/ghostty/releases/tag/tip),
[WASM API](https://github.com/ghostty-org/ghostty/blob/22f100c6367045bb5fc86172f837047dee2f7670/include/ghostty/vt/wasm.h),
[official example](https://github.com/ghostty-org/ghostty/blob/22f100c6367045bb5fc86172f837047dee2f7670/example/wasm-vt/index.html).

## Standalone measurements

Three alternating fresh processes per engine used shared input/output scratch
for all Ghostty terminals. The xterm side included Elwood's headless write queue
and cursor tracking from commit `34ab7dd5`. The snapshot paths differ: xterm extracts the full physical
viewport; Ghostty formats plain text. These numbers compare the prototypes,
not equivalent complete engines.

| Diagnostic median | xterm path | Ghostty WASM path |
|---|---:|---:|
| Parsing path CPU | 326.275 ms | 176.598 ms |
| Parsing plus snapshot/formatter CPU | 559.623 ms | 343.816 ms |
| Parsing plus snapshot/formatter RSS | 131.6 MiB | 139.5 MiB |

Parsing CPU samples were 345.918 / 326.275 / 229.376 ms for xterm and
225.668 / 147.451 / 176.598 ms for Ghostty. Snapshot/formatter samples were
575.996 / 559.623 / 429.162 ms and 356.796 / 343.816 / 322.240 ms.
The host was busy; all paired CPU comparisons favored the prototype, but the
variation is substantial. The approximately 39% lower median CPU in the
formatter comparison is not a whole-Elwood speedup.

Ghostty's shared linear memory reached 23.625 MiB; WASM allocations must not
be inferred from JS heap alone. Process RSS was not lower in the formatter
comparison. No lower-memory replacement conclusion follows from this trace.
An earlier per-terminal scratch variant allocated about 16 MiB unnecessarily;
only the shared-scratch measurements above are used for this comparison.

## Compatibility work required before replacement

Elwood needs exactly one line per physical viewport row, cursor coordinates
through scrollback and reflow, and cell-column prefix extraction for wide and
combining characters. Question editors require cursor-cell dimming to distinguish
placeholder text from real answers. Plain formatter output does not prove those
properties.

A replacement must also preserve parser-completion ordering, input ownership,
protocol replies, title updates, synchronized-output holds, resize events,
wrap-pending cursor positions and failure/disposal behavior. The WASM prototype
did not install the write-to-PTY callback; query responses were therefore absent.
Its marker checks establish only the diagnostic trace, not native CLI safety.

The next useful engine experiment would compare full viewport/cursor/style and
protocol-event fixtures through a compatibility adapter. A native addon should
follow only if measured WASM boundary costs justify its build/distribution cost.
Sources: [render state](https://github.com/ghostty-org/ghostty/blob/22f100c6367045bb5fc86172f837047dee2f7670/include/ghostty/vt/render.h),
[grid references](https://github.com/ghostty-org/ghostty/blob/22f100c6367045bb5fc86172f837047dee2f7670/include/ghostty/vt/grid_ref.h),
[terminal effects](https://github.com/ghostty-org/ghostty/blob/22f100c6367045bb5fc86172f837047dee2f7670/include/ghostty/vt/terminal.h).

## Other candidates

[libvterm 0.3.3](https://www.leonerd.org.uk/code/libvterm/) provides a screen and
output callbacks, but its released screen-cell attributes lack the dim/faint
flag used by question provenance. [vte](https://github.com/alacritty/vte) is a
parser rather than a complete terminal emulator.
[libtsm](https://github.com/Aetf/libtsm) still needs protocol, Unicode, dimming,
resize and packaging verification. None offered a measured compatible replacement
within this investigation.
