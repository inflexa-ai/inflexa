# Design

## The part places, the listing describes

The part carries the thread id alone, and the renderer joins the live report-children listing by it.
The alternative — render the part's own snapshot — was discarded: a part is immutable, and the
session is not. The title arrives after the child's first message, the activity stamp moves with
each turn, and an archive hides the row. A snapshot renderer would show a stale title and a dead
entry for an archived session, or it would grow its own reconciliation against the listing, which is
the machinery this change deletes, in a new place.

The rule is therefore one line: the row renders, or nothing does. The listing already narrows to the
live children of the open thread, thus an archived child leaves every surface at the next refresh
with no rule of its own here.

## The tail is the fallback, not a second mechanism

A child with no claiming part has no position. Two states produce one: a session spawned before the
part became durable, and a part whose message the mounted window dropped. The old rule answered the
second with the TOP, from the observation that an old spawn point sits above the window. The tail
answers both, and it was accepted for the first reason the old rule itself gave for its own end arm:
the tail is the one position that hides nothing. A claimed-set memo over the mounted parts is the
whole computation, against `slotFor`'s four arms over two joined orderings.

## The entry renderer lives beside the part switch

`ReportSessionEntry` sits in `message_block.tsx`, exported, with `Chat` as its second caller for the
tail. The join needs the listing signal and the open needs the workspace context, thus the component
follows the run-card precedent — `resolveRunCardState` reads the sidebar snapshots from the same
file — rather than the pure-widget rule of `components/`. `ReportSessionBlock` stays the pure
widget; the entry is the wiring around it.

## The live poke is an addition, not a replacement

The adapter refreshes the listing when the part arrives, thus the entry paints inside the turn. The
settle-edge read of `watchReportChildren` stays, because the title seed lands after the child's
first message, which is after the spawn. The refresh generation token already orders the two reads,
thus the poke adds no race. The poke is guarded on a bound analysis and session: `refreshReportChildren`
resets the listing on a null scope, and a mid-turn reset is not a degrade this arm may cause.

## What the deletion pays for

`slotFor` and its marks solved a real problem — the display projection drops the store sequence
number — with real costs: a second `toCortex` pass per load for the row boundaries, an
identity-not-index rule against two caps, and four documented edge arms whose interactions needed
their own unit suite. The part states the position inside the data that the transcript already
mounts, thus the whole join is unnecessary. The `[part:...]` default-arm mention disappears for the
same reason: the kind now has a renderer.
