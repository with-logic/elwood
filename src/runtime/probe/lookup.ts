/** Explicit missing-command proof on the existing private probe channels (PRD §9.2, C-PERF-05). */
import { randomBytes } from "node:crypto";
import { shellQuote } from "../shell-quote.ts";
import { StreamMarkerWatcher } from "../stream-marker.ts";
import { type ProbeStartChannel, probeControlFd } from "./start.ts";

const lookupLine = `elwood-probe-lookup-failed-${randomBytes(8).toString("hex")}`;
const lookupText = `${lookupLine}\n`;

/** Called after user not-found handlers are removed and before the private descriptor closes. */
export function commandLookupScript(command: string): string {
  return `if ! command -v ${shellQuote(command)} >/dev/null 2>&1; then { echo ${lookupLine} >&${probeControlFd}; } 2>/dev/null || echo ${lookupLine}; exit 127; fi; `;
}

export class ProbeCommandLookup {
  private readonly watchers: Readonly<Record<ProbeStartChannel, StreamMarkerWatcher>> = {
    control: new StreamMarkerWatcher(Buffer.from(lookupText)),
    stdout: new StreamMarkerWatcher(Buffer.from(lookupText)),
  };

  feed(channel: ProbeStartChannel, chunk: Buffer): void {
    this.watchers[channel].feed(chunk);
  }

  stripFromStdout(captured: string): string {
    return this.watchers.stdout.seen ? captured.replace(lookupText, "") : captured;
  }

  result(status: number | null): { readonly commandLookupFailed?: true } {
    return status === 127 && Object.values(this.watchers).some((watcher) => watcher.seen)
      ? { commandLookupFailed: true }
      : {};
  }
}
