# Design: render-a-zero-p-below-resolution

## Context

`formatNumberCell` and `selectNumberKind` (`src/report-render/number-format.ts`) format each shown numeric value. A zero in a p-value column takes the compact arm today, and the page prints `0`. The stored zero comes from an estimator that bottomed out, for example a permutation test whose count bounds the smallest reportable value.

## Decisions

### D1: The bound is data-derived, because any fixed bound lies somewhere

A fixed display such as `<1e-4` claims a resolution that the renderer does not know. A permutation test with 100 rounds has a resolution of `1e-2`, and the fixed claim would be false there. The one claim that is always true: the true value sits under the smallest positive value of the same column. That neighbor is at or above the resolution, thus `<` that neighbor holds for every estimator.

### D2: The neighbor rounds up to one significant digit

`<3.6e-4` reads as false precision, and the exact neighbor is not the message. The display rounds the bound up to one significant digit, `<4e-4`, thus the claim stays true and the text stays short. The raw stored cell — `0` — rides in the `title` attribute, exactly as the scientific kind carries its hidden digits.

### D3: `≈0` where no bound exists

A column whose positive values are absent gives no neighbor, and a metric has no column at all. Both render `≈0` with the raw cell on hover. The form claims nearness and no bound, thus it stays honest where the data gives nothing better.

### D4: The rule keys on the p-value meaning alone

A zero count and a zero effect are real values, and they keep their `0`. The rule fires for a declared `p-value` meaning and for a token-matched name, through the same resolution path that the declaration change built. Thus a declared and a name-matched column behave byte-identically.

### D5: The column context reaches the formatter as a precomputed bound

The table view computes the smallest positive value for each p-value column one time, and it hands the bound into the cell format. The formatter stays pure and column-blind, thus the metric path and every other caller stay untouched.

## Risks / Trade-offs

- A column with one real zero among real positives, where the zero is a true zero, would still render the bound form. A true zero p-value does not exist in practice, thus the risk is theoretical.
