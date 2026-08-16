# Tasks: orient-the-bar-horizontal

## 1. The contract

- [x] 1.1 The quick path admits the optional orientation beside `chartType`, and the bar series form admits it, in `src/contracts/report-blocks.ts`. The field descriptions teach when the horizontal form serves.

## 2. The derivation

- [x] 2.1 `deriveBar` renders the horizontal arrangement: the category axis on y with every label, and the value axis on x.
- [x] 2.2 An orientation beside a non-bar quick path refuses as a render problem.
- [x] 2.3 A composition that mixes a horizontal bar with another series refuses as a render problem.
- [x] 2.4 The axis titles, the declared labels, and the number rules bind to the axes wherever they render.

## 3. The proof

- [x] 3.1 Tests cover the six delta scenarios, and the vertical byte-identity pins against the stored option shape.
- [x] 3.2 Run the targeted suites of the touched modules, and `tsc -p tsconfig.json`.
