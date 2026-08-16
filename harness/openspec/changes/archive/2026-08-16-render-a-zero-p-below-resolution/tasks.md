# Tasks: render-a-zero-p-below-resolution

## 1. The formatter arm

- [x] 1.1 Add the below-resolution form to `src/report-render/number-format.ts`: a zero p-value with a precomputed positive bound renders `<` the bound, rounded up to one significant digit.
- [x] 1.2 Add the `≈0` arm for a zero p-value with no bound. The raw stored cell rides the `title` attribute in both arms.

## 2. The table context

- [x] 2.1 The table view computes the smallest positive value of each p-value column one time, and it hands the bound into the cell format.
- [x] 2.2 A zero in a column that is not a p-value keeps its `0`, declared or guessed alike.

## 3. The proof

- [x] 3.1 A test renders a zero FDR beside `0.00036`, and the cell shows `<4e-4` with the raw cell on hover.
- [x] 3.2 A test renders an all-zero p-value column, and the cell shows `≈0`.
- [x] 3.3 A test renders a zero in a `count` column, and the cell keeps `0`.
- [x] 3.4 Run the targeted suites of the touched modules, and `tsc -p tsconfig.json`.
