# Tasks: polish-the-chart-text

## 1. The preset titles

- [x] 1.1 The volcano and the manhattan expansions fill their semantic axis titles in `src/report-render/chart-presets.ts`.
- [x] 1.2 The title precedence lands where the axis name resolves: agent axes, declared label, preset title, then the raw or derived name.

## 2. The muted null category

- [x] 2.1 The design source names one muted chart color.
- [x] 2.2 A preset-expanded chart assigns it to the series whose category value is exactly `ns`.

## 3. The guide labels

- [x] 3.1 A vertical reference line labels at the axis end, and a horizontal line keeps the right edge.

## 4. The legend words

- [x] 4.1 A category series name prettifies at derivation: underscores become spaces. The tooltip reads the same name.

## 5. The proof

- [x] 5.1 Tests cover the five delta scenarios, in the existing chart-test style.
- [x] 5.2 A chart with no preset and no category stays byte-identical to before.
- [x] 5.3 Run the targeted suites of the touched modules, and `tsc -p tsconfig.json`.
