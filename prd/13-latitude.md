## 13. Implementation Latitude

The following are implementation choices unless they affect the public behavior
above:

- PTY library or native binding choice.
- IPC transport details, provided it is local-only and session-scoped.
- Exact generated settings file layout.
- Exact event-emitter implementation.
- Whether the package runs on Node.js or another compatible JavaScript runtime, as long as the TypeScript API
  contract is met by supported hosts.
- Internal storage filenames under `.elwood/`.

The documentation site's sprite-load errors identify the failing relative asset
path, bounded to 200 characters, and retain the underlying error as their cause.

Sprite requests for the same metadata or atlas key share one fetch/decode operation.
An explicit consumer may cancel without cancelling remaining consumers or silencing
their automatic failure report. Only the final consumer cancels the underlying
operation; an abandoned completion cannot publish into a successor request.
Explicitly retained pages stay alive through delivery and cache eviction until their
owner releases them, while current/outgoing pose owners remain protected.
After successful complete animation preparation, the shared idle clip's two shipped
pages remain leased for that sprite bank's lifetime, so later actions reuse them
without repeated fetching or decoding. Failed or cancelled preparations do not
establish this lease. The shared lease is capped at two pages: an idle manifest
with more pages falls back to ordinary animation/cache ownership.
The ordinary cache remains capped at four pages; rotation and action pages receive
no bank-lifetime lease. Disposal releases the shared idle lease together with all
other resource owners.

Sprite decoder requests may carry an abort signal. Cancellation rejects the
request promptly, skips requests that have not started decoding, and
never falls back to another decoder. The internal worker protocol pairs decode
request IDs with cancellation messages and completion acknowledgements. The page
owns the waiting queue and sends one request at a time; aborting the active
request does not release that physical slot until the worker replies. In-flight
browser bitmap decoding cannot be interrupted; its eventual image is released,
without terminating the worker or cancelling other requests. Settled requests remove their abort listeners.

Automatic gesture and facing tasks may wait at most eight seconds before delivery.
Once elapsed time exceeds eight seconds, the next simulation update cancels the
task before checking asset readiness or silhouette fit. Assets becoming ready
between updates cannot revive that expired task; delivery at exactly eight seconds
remains eligible. This limit does not shorten an action already delivered.

### 13.1 Landing-page explicit animation controls

Landing gesture and front/back requests wait for every page of the requested clip,
idle and rotation before delivering input. Pending explicit loading suppresses
automatic actions. Requests are ineligible while dragging, holding movement,
airborne, hanging, climbing, landing, settling, or committed to a pending jump or
jump wind-up. Eligibility is checked before loading and again before delivery.

A request accepted into an existing gesture's recovery queue retains its delivered
pages until playback activation or replacement. Activation owns the requested clip
before the opening turn paints. Held movement that clears the recovery queue also
releases its delivered request. Reset, responsive reflow and supersession cancel
pending/delivered work while preserving active/outgoing poses; reflow preserves
held movement. Superseding a gesture/facing request preserves unrelated pending
input such as a jump press. Workshop controls and automatic/pickup paths retain
their separate on-demand loading behavior.

### 13.2 Landing-page initial animation readiness

The landing page keeps its static fallback until every initial idle page is decoded
and retained for playback. Initial preparation fetches idle only; rotation and other
clips remain on demand. The live readiness callback and first painted handoff occur
only after complete idle preparation. Input and visibility changes before readiness
do not cancel initial preparation. Teardown cancels it and prevents a late handoff.
An asset failure reports the existing contextual error and preserves the fallback;
a later explicit boot attempt may retry. Idle pages remain available through cache
eviction and later playback changes through the shared idle lease, with
current/outgoing pose ownership preserved.
