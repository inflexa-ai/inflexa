## Why

The chart encoding holds four column names, and no more. In the first real session the tooltip showed nothing, and the axis read a raw column name. Every point shared one color, and a faithful volcano was impossible. The failure is a typed surface that is too poor, not missing power.

## What Changes

- The chart block gains a typed composition: one or more series, each with a form (`line`, `scatter`, `bar`, `area`, `step`) and its own column encoding.
- Annotations are typed members: a reference line, a reference band, and point labels for a declared top-N subset.
- A channel accepts a per-row pure transform: `log10`, `neg_log10`, `abs`, or `rank`. Each derived value traces to one cell.
- Axes carry titles and scales, and the number helper bounds what the static option admits.
- The encoding gains a `label` channel, thus a tooltip names its point. A dense scatter takes a larger hit radius.
- The current chart types stay as the quick path, and the genomics presets (`volcano`, `manhattan`, `ma`, `km`) join them. A preset expands into the composition inside the renderer.
- The structural tier covers every column that the grammar names.

## The boundary that stands

The agent authors no raw echarts option. The encoding carries column names, and the resolver supplies every value from the hash-pinned artifact. Series data literals and function formatters stay unrepresentable.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-block-model`: a new requirement gives the chart grammar: the composition, the annotations, the transforms, the presets, and the unrepresentable holes.
- `report-render`: the derivation grows the composition, the preset expansion, the annotations, the tooltip, and the hit radius.

## Impact

- `harness/src/contracts/report-blocks.ts` — the grammar schema.
- `harness/src/report-render/chart.ts` — the expansion and the derivation.
- `harness/src/report-model/` — the structural walk over the new members.
- The contract is exported, thus the linked-harness cli typecheck gates the change.
