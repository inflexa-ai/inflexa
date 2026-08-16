# Design: polish-the-chart-text

## Context

The preset expansions live in `src/report-render/chart-presets.ts`. `plainTitle` titles the x axis with the raw column, and a transformed channel takes no title, thus the derived name (`neg_log10(pvalue)`) states the y quantity. The reference-line annotations carry no position, and the chart runtime prints a vertical line's value label at the top. The series names take the raw category values (`chart.ts`, the group split), and the palette assigns colors by order.

## Decisions

### D1: A preset states its semantic titles, under the declared label

The volcano guide lines sit at `±1`, which is a log2 claim. Thus the preset honestly titles its x axis "log2 fold change" and its y axis "−log10(p)". The manhattan titles its y axis "−log10(p)", and its x keeps the position column. The `ma` and `km` presets keep the column path, because their axes carry no fixed quantity. The precedence, most specific first: an agent axes title, a declared column label, the preset title, then the raw or derived name.

### D2: The null category is the literal value `ns`

The volcano convention writes the insignificant category as `ns`, and the preset draws the significance split itself. A category whose value is exactly `ns` on a preset-expanded chart takes the muted chart color of the design source. A wider heuristic would guess, and a wrong guess mutes a real finding. The rule is narrow, stated, and testable.

### D3: A vertical guide labels at the axis end

The label of a vertical reference line takes the start position, at the axis, out of the title band. A horizontal line keeps the end position, at the right edge, where the session page already reads well.

### D4: A category series name prettifies at derivation

Underscores become spaces in a series name, deterministically, at derivation time. The tooltip template reads the series name, thus the two agree. No legend hover carries the raw value, because a legend formatter is a function and the option rides as inline JSON. The raw value stays in the data rows, thus the provenance loses nothing.

## Risks / Trade-offs

- A volcano over a non-log2 effect column would carry a wrong x title. The guide lines at `±1` already make that claim, thus the title adds no new wrongness, and the agent axes override corrects both.
- Two category values that differ only in underscores collapse to one legend text. The series stay distinct, and the case is not real data practice.
