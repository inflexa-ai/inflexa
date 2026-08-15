## Context

The table view emits every resolved row as plain markup (`views/values.tsx`). The page scripts live in `page.ts` as browser source text. The design rules live in `design.ts` under the emitter invariant. The page must stay deterministic and self-contained. Thus the enhancer is presentation over a complete DOM, and never a data layer.

## Goals / Non-Goals

- Goal: a reader sorts, filters, and expands a table on the page, with no dependency.
- Goal: a noisy set name reads clean, and the full text stays reachable.
- Non-goal: a framework, a build step, or hydration. The verifier and the eyes pin a static document.
- Non-goal: a block field for the cap. The renderer owns the default, and the column subset stays the content-level knob.

## Decisions

- **The sort reads a data attribute, never the shown text.** The view emits the raw cell value on each cell as `data-value`, thus the formatted text stays presentation. A column sorts numerically when every non-empty value parses as a number, and by code-unit text order otherwise. A click cycles ascending, descending, and the document order. The document order is recoverable because the script records the initial index on each row.
- **The filter is one input for each table.** A substring match against the text of a row hides the misses with the hidden class. The filter and the cap compose: the cap counts only the rows that the filter keeps.
- **The cap is a renderer constant of 20 rows.** The view marks each row past the cap with the hidden class. When the rows exceed the cap, the view emits the toggle with the total count. The toggle flips between "show all N" and "show fewer". The print rules reveal every hidden row, because paper has no toggle.
- **The trim is a renderer rule with one shape.** A cell whose text holds two or more percent-delimited segments shows the first segment, and the full text rides the `title` attribute. This serves the encoded set names, and it touches no ordinary cell.
- **The enhancer is one script beside the spy.** It follows the conventions of the page scripts: browser source text, no module binding, interpolated constants, and a no-support path that leaves plain markup usable.

## Risks / Trade-offs

- [A sorted table contradicts the capped subset] → the cap hides by count over the current order. The visible rows are the first of the current view. The script applies the cap again after each sort and each filter.
- [The toggle steals the readiness signal] → the enhancer registers no reveal work and touches neither the gate nor the sentinel.

## Open Questions

None.
