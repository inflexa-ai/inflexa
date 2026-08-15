## Context

The render path is pure and deterministic (`report-render/render.ts`), and the identity lives in one design source (`report-render/design.ts`). The views emit plain HTML strings. The chart derivation (`chart.ts`) builds one ECharts option per chart block, and its own doc bans a locale read and a clock read. The first real report showed clipped metric cards, 16-digit table cells, and long float axis ticks.

## Goals / Non-Goals

- Goal: one number helper in the render layer, applied at the metric value and at the numeric table cell. The chart takes only the static count-axis bound.
- Goal: the full digits on hover through the `title` attribute, only when the shown form hides digits. The `Price` component of Lumen is the reference for that rule.
- Goal: a metric-card overflow guard in the design CSS.
- Non-goal: a format field on any block. A block names content, never presentation.
- Non-goal: prose rounding. The agent authors prose, and the renderer does not rewrite it.

## Decisions

- **The helper is a pure function in the render layer, beside the design source.** It takes a cell (`string | number`) and a kind, and it gives `{ text, full? }`. `full` is present only when `text` hides digits, and the view emits `title` from it. The alternative was a formatter inside each view, and that drifts.
- **The four kinds.** `scientific`: a coefficient with 2 significant digits and an `e` exponent, for example `4.3e-5`. `compact`: an integer with comma grouping, for example `14,201`. `compact-scientific`: a decimal rounded to 3 significant digits, for example `-3.09`. It falls to the scientific form under `1e-3`, and it shows a grouped whole number from `1e3` up to `1e15`. `identifier`: the pass-through of an identifier cell, with no grouping and no title.
- **The kind selection is by magnitude and by column meaning.** A p-value token in the column name (`p`, `pval`, `pvalue`, `padj`, `fdr`, `q`, `qval`) selects `scientific` for a value in `(0, 1e-2)`. An identifier token (`id`, `pmid`, `doi`, `entrez`, `taxid`, `year`, `accession`) selects the pass-through. The match reads whole tokens only. An integer value selects `compact`. Every other finite number selects `compact-scientific`. A non-numeric cell passes through unchanged.
- **No locale API.** The grouping writes its own comma insertion, and the exponent form derives from `toExponential`. `toLocaleString` would break the determinism rule of the render function.
- **The axis labels format inside the option, without a function.** The option rides as inline JSON, thus a function formatter is impossible. A string template of ECharts can carry `{value}` alone. Thus the derivation bounds the tick precision where the option admits text. Where it cannot, the axis keeps the ECharts default, and the scenario stays honest about that bound.
- **The overflow guard.** `.stat-card-value` gains `overflow-wrap: anywhere` and a smaller size step under a container query is out of scope. The formatted value is short by construction, thus the guard is a backstop and not the fix.

## Risks / Trade-offs

- [A p-value token match can misread an unrelated column] → the match reads whole tokens, split on `_` and on case. It never reads a bare substring.
- [The option admits no text for some ticks] → the axis keeps the default there. The scenario states the bound, thus the spec stays true.

## Open Questions

None.
