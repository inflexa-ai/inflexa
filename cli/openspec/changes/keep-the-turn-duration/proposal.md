## Why

The third report transcript shows the turn duration on one turn of six. The live header shows it, the reload drops it, and a copied transcript then understates the work. The harness change `report-round-three` adds the durable duration beside the usage rollup on the turn append. This change consumes that field: the cli passes the duration at the append, and the reload renders it.

## What Changes

- The chat turn passes the measured duration to the harness turn append, beside the usage rollup it already passes.
- The transcript load renders the stored duration on the assistant header, thus a reloaded turn reads as it did live.
- A row that predates the field, and an aborted turn, keep an absent duration. Absence keeps one meaning: the value was never recorded.
- The report-session entry moves below the turn that asked for it. The spawn anchors before that turn appends, thus a reloaded transcript painted the entry above the request. The placement rule now targets the reply of the turn that crosses the anchor.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tui-layout`: the assistant meta line requirement drops the not-stored stance on the duration, and the reload scenario carries it.
- `report-session-navigation`: the entry-placement requirement targets the reply of the crossing turn, thus the entry never sits above its request.

## Impact

- `cli/src/modules/harness/turn.ts` — the append call carries the duration.
- `cli/src/tui/hooks/conversation.ts` — the load maps the stored duration onto the header.
- `cli/src/tui/components/chat.tsx` — the `slotFor` placement rule of the report-session entry.
- Depends on the harness field of `report-round-three`, through the linked working-copy harness.
