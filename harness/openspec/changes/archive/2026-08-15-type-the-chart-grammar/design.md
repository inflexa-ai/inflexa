## Context

`ChartBlockSchema` carries one type enum and a four-channel encoding (`contracts/report-blocks.ts`). The derivation holds one fixed rule for each type, computes no aggregate, and stays deterministic (`report-render/chart.ts`). The option rides as inline JSON, thus no function can ride it. A string template of the chart runtime is static text, and it can name a point.

## Goals / Non-Goals

- Goal: a composition that expresses real scientific charts, with every value from the pinned artifact.
- Goal: the quick path stays one field, and a preset expands into the composition inside the renderer.
- Non-goal: a raw option surface. Series data literals and function formatters stay unrepresentable.
- Non-goal: a second binding. A chart composes over its one bound table.
- Non-goal: a statistical estimator in the renderer. The `km` preset renders precomputed survival columns, and it estimates nothing.

## Decisions

- **A channel is a column name, or a column with a transform.** The channel schema is a union of a plain string and `{ column, transform }`. The transform enum is `log10`, `neg_log10`, `abs`, and `rank`. The first three are per-row pure. `rank` is a deterministic derivation over the column: competition ranking over ascending numeric order, and a tie shares its rank. Each derived value traces to one cell, thus the no-aggregate rule holds.
- **The encoding gains `label`.** The label column names a point. The derivation puts it on the data item as its name, and a static template formatter shows the name with the values. A template is static text, thus the script hole stays closed.
- **A series is a form with its own encoding.** The forms are `line`, `scatter`, `bar`, `area`, and `step`. A `step` series is a line with the step flag. An `area` series takes an optional `y0` lower-bound column, thus a per-row band between two columns is expressible. Each series reads the one bound table.
- **Annotations are three typed members.** A reference line names an axis and a constant value. A reference band names an axis and two constants. Point labels name a rank rule: a column, an order, and an `n` bounded at 20. An annotation constant is a declared guide, and never a plotted data value.
- **The composition is exclusive with the quick path.** The block carries either `chartType` with `encoding`, or `composition`. A refine makes the exactly-one rule a parse failure. The seven current types stay, and `volcano`, `manhattan`, and `ma`, and `km` join the enum as presets.
- **A preset expands inside the renderer.** The expansion is a pure function from the preset and its encoding onto a composition. The volcano takes the effect column on x and the p column on y through `neg_log10`, with the declared guide lines. The `km` preset takes precomputed survival columns as grouped step series. Thus the derivation has one grammar path, and a preset is sugar.
- **Axes carry titles and scales.** A scale is `linear` or `log`, mapped onto the static axis type. A title replaces the raw column name where the author gives one.
- **The structural tier walks every named column.** The walk covers each series channel, each transform column, the label, the rank column, and `y0`. A name that the bound table does not hold refuses before a landing.
- **The dense scatter takes a larger hit radius.** A row count over a threshold raises the symbol size one step, as a static field.
- **A transform over an unusable cell drops the point.** `log10` and `neg_log10` over a non-positive value give null, and the point drops, the same as a non-numeric cell today. The drop is deterministic, and no substitute value appears.

## Risks / Trade-offs

- [The grammar grows the published block schema] → the schema is the one place the model learns the shape, thus the growth is the point. The descriptions stay short.
- [A preset default hides a judgment] → each preset default is a declared constant in one expansion module. The caption still belongs to the author.
- [Two representations of one chart] → the expansion runs before the derivation, thus the derivation reads one shape and the two paths cannot drift.

## Open Questions

None.
