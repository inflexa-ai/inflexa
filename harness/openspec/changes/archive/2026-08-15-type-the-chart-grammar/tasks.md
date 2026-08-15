## 1. The contract

- [x] 1.1 The channel schema, the series schema, the annotations, the axes, and the composition in `src/contracts/report-blocks.ts`. The exactly-one refine between the quick path and the composition.
- [x] 1.2 The `label` channel on the encoding, and the preset members on the type enum.
- [x] 1.3 Contract tests: each new member, the exclusivity, and the unrepresentable holes.

## 2. The structural walk

- [x] 2.1 Extend the column coverage of the structural tier over every grammar name: the series channels, the transform columns, the label, the rank column, and `y0`.
- [x] 2.2 Tests: a grammar column outside the table refuses, and a valid composition lands.

## 3. The renderer

- [x] 3.1 The preset expansion module: one pure function from a preset onto a composition, with the declared guide constants.
- [x] 3.2 The composition derivation in `src/report-render/chart.ts`: the series, the transforms, the rank, the annotations, the axes, the tooltip template, and the hit radius.
- [x] 3.3 Renderer tests: the volcano, the tooltip name, the rank determinism, the area band, the static annotations, and the base types unchanged.

## 4. The gates

- [x] 4.1 Run the targeted contract, report-model, and report-render suites only.
- [x] 4.2 Run `bun run format:file` on the touched `src/` files, then `tsc -p tsconfig.json`.
- [x] 4.3 The contract is exported, thus run `bun run harness:local` from `cli/` and the cli typecheck.
- [x] 4.4 Render a composition proof page to the scratchpad, and confirm the tooltip template and the annotations in the emitted option.
