# Design: declare-the-column-meaning

## Context

`selectNumberKind(column, cell)` (`src/report-render/number-format.ts:102`) picks the kind from the column name and the magnitude. The name half tokenizes the column and matches `P_VALUE_TOKENS`. The chart derivation names an axis with the raw column (`src/report-render/chart.ts:102`), and the table header prints the raw name. Nothing lets the author state what a column is or how it reads.

## Decisions

### D1: The declaration rides the whole-table binding

`ArtifactTableReferenceSchema` gains `columnMeanings` and `columnLabels`, both optional records keyed by the column name. The table block and the chart block bind through this one schema, thus one declaration serves both. A value locator declares nothing, because one cell has no column-wide meaning to state.

### D2: The meanings are a closed enum of five

`p-value`, `effect`, `count`, `identifier`, `category`. A declared meaning routes the column onto the same resolution arm that the name guess selects, and the magnitude arms stay. Thus a declared column renders byte-identically to a name-matched column of the same nature. A `category` passes through as text, and it is the one meaning with no name-guess counterpart. The routing lives beside the number helper, thus a block still carries no format field and the round-one layer decision stands.

### D3: The declaration wins, the guess falls back

The kind resolution takes an optional declared meaning beside the column name. A declared meaning replaces the name guess alone, and the magnitude arms stay. Thus a declared `p-value` column renders byte-identically to a token-matched one, and `0.536` stays `0.536` under both. An undeclared column keeps the token-and-magnitude guess, thus every stored document renders as before. The token set stays as code, and its comment names its demoted role.

### D4: A label is display text with the raw name on hover

A declared label replaces the column name in the table header and in the axis title of a chart channel that reads the column. The raw name rides in the `title` attribute of the header, and the axis keeps its deterministic derivation.

An undeclared column header prettifies as the fallback: underscores become spaces, and the raw name rides on hover when the two differ. The prettification is a display rule of the design source, thus no block carries it. The axis title of an undeclared column stays the raw name, because the preset-title work of a sibling change owns the chart text.

### D5: An unknown key is ignored

A meaning or a label whose key names no column in the artifact simply never matches. No validation error, because absence is a normal condition, and a stale declaration after a re-derivation must not kill the render.

## Risks / Trade-offs

- An author can declare a wrong meaning, and the page then formats a column wrongly. The declaration is content, thus the review of the draft is the check, exactly as for a caption.
- Two optional records widen the authoring schema. The field descriptions carry the teaching, thus the prompt stays unchanged.
