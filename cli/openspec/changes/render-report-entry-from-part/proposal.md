# Render the report entry from the persisted spawn part

## Why

The harness change `emit-report-session-started-part` makes `start_report_session` emit a
`data-report-session-started` part, and the conversation display recorder persists it into the turn
at the position of the spawn. The transcript now carries the spawn point as a part, thus the TUI's
own placement machinery — the seq-mark join and the crossing-turn walk — computes a fact that the
transcript already states.

That machinery is the most intricate placement code in the TUI: `slotFor` documents four edge arms,
the marks pair a store sequence number with a message identity across two caps, and a second
`toCortex` pass exists only to recover the row boundaries. Each of these exists because the display
projection drops the sequence number. The part removes the reason.

Without a renderer, the part also degrades: the adapter's default arm paints a
`[part:data-report-session-started]` mention at each spawn point, beside the entry that the listing
already places.

## What Changes

- The `Part` union gains a `report-session` kind that carries the spawned thread id. The live
  adapter and the reload path map `data-report-session-started` onto it through one shared reader.
- `MessageBlock` renders the kind as the report-session entry: it joins the live report-children
  listing by thread id, reads the title and the activity stamp off the row, and renders nothing when
  the listing does not hold the row. The listing stays the authority for the session — its
  existence, its title, and its archived state.
- `Chat` renders a tail entry for each live child that no mounted part claims — a session spawned
  before the part became durable, or a part whose message left the mounted window. **BREAKING** for
  the old placement outcomes: an anchor below the mounted window rendered at the top, and it now
  renders at the tail.
- The live adapter pokes the report-children listing when the part arrives, thus the entry paints
  inside the turn rather than at its settlement. The settle-edge read stays, because pg seeds the
  title after the child's first message.
- `slotFor`, the `MessageSeqMark` join, and the per-position entry slots are deleted.
- The harness pin moves to 0.23.0, which is the release that carries the part.

## Capabilities

### New Capabilities

<!-- None. This change consumes a harness capability; every behaviour lands in an existing cli spec. -->

### Modified Capabilities

- `report-session-navigation`: the transcript entry anchors at the persisted spawn part, joined
  against the listing; the unclaimed children render at the tail; the seq-mark placement rule is
  removed.
- `tui-harness-chat`: the emit adapter and the reload path map `data-report-session-started` to a
  `report-session` part, and the live arrival refreshes the report-children listing.
- `tui-stream-blocks`: `MessageBlock` renders the `report-session` kind by joining the live listing,
  with the listing as the authority.

## Impact

CLI source:

- `src/types/session.ts` — the `ReportSessionPart` kind.
- `src/modules/harness/chat_printer.ts` — the `readReportSessionStarted` reader.
- `src/tui/hooks/conversation.ts` — the two mapping arms; the seq-mark signal, its writers, and
  `seqMarksFor` deleted.
- `src/tui/layout/message_block.tsx` — the `report-session` case and the `ReportSessionEntry`
  renderer.
- `src/tui/components/chat.tsx` — `slotFor` and the entry slots deleted; the claimed-set memo and
  the tail render remain.
- `cli/package.json` — harness `0.21.1 → 0.23.0`, cli `0.13.1 → 0.14.0`.

Tests: the placement render suite re-anchors on the part; the seq-mark unit suite goes with the
machinery; the adapter suites gain the two mapping arms.
