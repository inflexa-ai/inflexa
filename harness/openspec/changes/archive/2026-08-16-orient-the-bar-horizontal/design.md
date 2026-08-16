# Design: orient-the-bar-horizontal

## Context

`ChartTypeSchema` (`src/contracts/report-blocks.ts:30`) names the quick-path types, and the composition series form sits at line 77. `deriveBar` (`src/report-render/chart.ts:357`) renders the category on x and the value on y, with no other arrangement. The GSEA NES chart wants the category on y, because a gene-set name is long and a slanted x label is unreadable.

## Decisions

### D1: The orientation is a field, not a new type

A `horizontal-bar` chart type would double the bar rules and split the tests. The orientation is one optional enum field, `vertical` by default. The quick path carries it beside `chartType`, and the composition carries it on the bar series form. An absent field keeps every stored document byte-identical.

### D2: The channels keep their data meaning

`x` names the category column and `y` names the value column, in both orientations. The horizontal orientation renders the category axis on y and the value axis on x. One encoding thus serves both orientations, and the author flips one field instead of rewriting the channels.

### D3: A non-bar quick path refuses the orientation

An orientation beside `line` or `pie` is a stated authoring fault, and the render problem names it. A silent ignore would teach the author a field that does nothing.

### D4: Annotations and text rules bind to rendered axes

An annotation names a rendered axis, exactly as today, thus a zero line on a horizontal value axis is an `x` reference line. The axis titles, the declared labels, and the number formatting bind to the axes wherever they render. The category axis of a horizontal bar keeps every label, because the long names are the reason the orientation exists.

### D5: The mixed-form guard covers the orientation

A composition that mixes a horizontal bar with another series on one grid has no honest shared axis pair. The derivation refuses the mix as a render problem, exactly as the grammar refuses a form pair that shares no axis semantics today. One series per orientation keeps the rule simple, and the GSEA case wants one series alone.

## Risks / Trade-offs

- A horizontal bar with many categories grows tall inside a fixed container. The container height is a design-source concern, and the row bound of the binding is the size control.
