## Context

The live assistant header shows the turn duration, and the reload drops it. The load path says so at `cli/src/tui/hooks/conversation.ts:1104`: the duration is not durable, and it stays absent. The harness change `report-round-three` adds the durable duration beside the usage rollup on the turn append, with the same optional semantics. This change is the cli half: pass the measured value in, and render the stored value out.

## Goals / Non-Goals

**Goals:**

- The append carries the duration that the turn header already measured.
- The reload renders the stored duration, thus a reopened transcript reads as it did live.

**Non-Goals:**

- No reconstruction for old rows: an absent duration stays absent.
- No change to the usage figures, the ledger, or the meta-line layout.

## Decisions

- **The duration rides the same call as the rollup.** The engine brackets the turn with its own clock, and the append already passes the rollup. One more field on one call, thus no new seam and no second write.
- **Absence keeps one meaning.** An old row, and an aborted turn, read back without a duration, and the header shows none. Nothing estimates a value, which keeps the fabrication ban of the meta line whole.
- **The dependency is the linked harness.** The field lands in `report-round-three`, and this change applies after it, on the working-copy link. No registry release is necessary for the apply.
- **The entry placement is a display rule, and the anchor stays as stored.** The spawn mints the anchor before the requesting turn appends, and that fact is correct provenance. The fix targets the reply of the turn that crosses the anchor (`slotFor`, `cli/src/tui/components/chat.tsx:58-73`). The live spawn already lands at the end, thus only the reload arm changes. A harness-side anchor shift was rejected: the spawn cannot know the sequence numbers of an append that has not run.

## Risks / Trade-offs

- [The harness field could land with a different shape.] → The apply reads the landed harness surface first, and the task list starts there.

## Open Questions

None.
