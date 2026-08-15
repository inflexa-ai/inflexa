## Why

The renderer prints each resolved value at full float precision. On the first real report a metric card clipped `-5.7618623255…`, a p-value wrapped onto a second line, and a table cell printed 16 significant digits. The prose and the cards also round differently.

## What Changes

- One number helper lands in the report-render layer, beside the design source. It has three kinds: `scientific`, `compact`, and `compact-scientific`.
- The renderer applies the helper to the metric value and to each numeric table cell. The chart option admits no formatter, thus only the histogram count axis takes a static whole-tick bound.
- The renderer picks the kind by magnitude and by column meaning. No block gains a format field, because a block names content and never presentation.
- The full digits appear on hover, through the `title` attribute. The tooltip appears only when the helper hid digits.
- The metric card gains an overflow guard, thus a value can never paint past its card edge.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-render`: a new requirement gives the number format of a resolved numeric value: the three kinds, the kind selection, and the full-digits hover.
- `report-design-system`: the metric-card component gains the overflow guard, thus a long value stays inside the card.

## Impact

- `harness/src/report-render/number-format.ts` — the helper.
- `harness/src/report-render/design.ts` — the overflow guard.
- `harness/src/report-render/views/values.tsx` — the call sites of the helper.
- `harness/src/report-render/chart.ts` — the count-axis bound.
- No contract change, no agent change, and no store change.
