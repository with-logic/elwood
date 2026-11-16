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
The ordinary cache is bounded by decoded pixel memory instead of a page count:
twelve full 2048-pixel RGBA sheets, or six when the browser reports at most 4 GB of
device memory. Each page is charged its own width × height × 4 bytes, and a page of
unknown size is charged as one full sheet. The least recently used pages are released
first; the newest page always stays. Rotation and action pages receive
no bank-lifetime lease. Disposal releases the shared idle lease together with all
other resource owners.

Sprite decoder requests may carry an abort signal. Cancellation rejects the
request promptly, skips requests that have not started decoding, and
never falls back to another decoder. The internal worker protocol pairs decode
request IDs with cancellation messages and completion acknowledgements. The page
owns the waiting queue and gives each worker one request at a time. It runs up to
four workers: one fewer than the reported processor count, and never fewer than one.
One worker starts with the decoder; another starts only when every running worker is
busy. Aborting an active request does not release that worker's slot until the
worker replies. A worker that cannot start leaves the running workers in service,
whether its constructor throws or it reports an error before its first reply: its
request returns to the front of the queue unless the caller already cancelled it,
and it is not replaced. A failure of the only worker, or of a worker that has
replied, moves every pending request to page decoding and stops all workers. In-flight
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
input such as a jump press. Workshop paths retain on-demand loading; automatic moments and facing follow
§13.3, and suspended pickup follows §13.4.

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

### 13.3 Automatic gesture and facing readiness

Automatic moments and facing actions wait for all requested, idle and rotation
pages before delivering input. Their post-delivery clock starts only when complete
preparation succeeds. The existing eight-second pre-delivery wait bounds loading;
expiry cancels that task without reporting an asset failure. Geometry probes remain
metadata-only and share existing loads. Publication requires the exact prepared
candidate, or the same complete active owner with no newer candidate/delivery.
Task replacement, manual takeover, reset/reflow and teardown release obsolete
metadata/preparation consumers. Cancellation removes a matching queued delivery,
but cannot release a newer manual request or active/current/outgoing playback.
An automatic asset failure reports once. Failed requested or shared idle/rotation
assets suppress later automatic attempts that need them, including other actions,
until explicit preparation clears the relevant failure state. Unchanged paint ticks
cannot retry or republish a failed or superseded task. Walking remains on demand.

### 13.4 Landing-page pickup readiness

Pickup takes pointer/keyboard control immediately while the current drawable clip
continues playing. Suspended wriggle (or zero-gravity fallback) starts at time zero
only after all its sheets and idle/rotation dependencies are ready and owned by
that drag. Pointer movement preserves preparation. Drop, pause, reset, reflow and
teardown cancel pending pickup; a late completion cannot start obsolete playback.
Current/outgoing poses remain retained. Failure reports once for the current drag;
movement and painting do not retry, but a new drag may retry. Falling and landing
transitions retain their existing on-demand behavior.

### 13.5 Landing-page loading ahead of use

After the live handoff the landing page loads the clips a visitor reaches first, so
movement and pickup do not wait for a download or a decode. Rotation, both walks,
the side stances, landing, landing rest and jump are decoded into the ordinary
cache, in that order and one clip at a time, so a clip the visitor asks for waits
behind at most one of them. Suspended pickup footage, the pickup fall and landing,
sprint and the front and rear stances are only downloaded, one request at a time at
low priority, so the browser's HTTP cache holds them. Pointer hover or keyboard
focus on the robot decodes the suspended pickup clip before the press arrives; its
fall and landing are decoded when the drag begins.

A clip is decoded ahead only when it fits the cache budget beside idle and the clips
already kept from the handoff, so loading ahead never evicts that set. With the
shipped sheets, the twelve-sheet cache keeps every handoff clip and the hovered
pickup. The six-sheet cache keeps every handoff clip except the jump and leaves the
pickup to decode on the press.

Loading ahead never changes ownership or readiness. Decoded pages enter the ordinary
cache with no lease and leave it like any other page. Requests are shared with
automatic and explicit loads. A failure reports nothing and sets no failure state,
so the first real use of that clip makes the attempt that reports; a failure shared
with an automatic or explicit load is reported by that load as usual. Download-only
requests report nothing and stop a clip at its first failed, missing or invalid
file. Complete readiness under §13.1, §13.3 and §13.4 is unchanged.

Visitors whose browser reports a data-saving preference, and visitors who ask for
reduced motion, get no loading ahead at the handoff; hover and focus still decode
the pickup clip. Browsers that expose no data-saving signal load ahead. Teardown
stops remaining downloads.
