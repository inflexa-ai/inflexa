# Proposal: render-a-zero-p-below-resolution

## Why

The GSEA table of the second real session prints a literal `0` in the FDR column. The source CSV holds a real zero, because the permutation count bounds the resolution of the estimate. A zero p-value or FDR is not a real claim, and a reviewer reads it as an error.

## What Changes

- A zero in a column whose meaning is a p-value renders as a below-resolution form, never as a bare `0`.
- In a table, the form is data-derived and honest: `<` the smallest positive value of the same column, rounded up to one significant digit. A stored zero means that the true value sits under the resolution of the estimator. The smallest positive neighbor bounds that resolution from above, thus the claim is always true.
- When the column holds no positive value, and on a metric, the form is `≈0`, because no honest bound exists there.
- The raw stored cell rides on hover, exactly as the hidden digits of the scientific kind do.
- The rule keys on the column meaning: a declared `p-value`, or a token-matched name. Every other column keeps its zero, because a zero count and a zero effect are real values.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-render`: the number-format requirement gains the below-resolution rule for a zero p-value.

## Impact

- Affected code: `src/report-render/number-format.ts`, the table view, and their tests.
- No contract change. The chart transform already drops a non-positive p-value row, thus no chart work exists.
- The prose half — the agent never transcribes a zero p into a sentence — rides the prompt child of the tracker.
