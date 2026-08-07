## 1. The toolchain

- [ ] 1.1 Apply the spike diffs: `"jsx": "react-jsx"` and `"jsxImportSource": "hono/jsx"` in `tsconfig.json`, the `src/**/*.test.tsx` exclude, and `tsx` in the two eslint globs.
- [ ] 1.2 Prove the toolchain in-tree: one minimal `.tsx` component compiles with `tsc`, its test runs under bun, and the lint rules fire on it. Then fold the file into the first conversion, and leave no scratch.

## 2. The markup conversion

- [ ] 2.1 Convert the prose layer to components: the text block, the claim with its markers, the section wrapper with the heading by depth, and the navigation. `class` only, and never `className`.
- [ ] 2.2 Convert the value layer to components: the metric card, the table, the figure, the citation line, and the reference list.
- [ ] 2.3 Convert the chart container and the page assembly: the container with its adjacent JSON script through `raw()`, the skeleton, and the theme registration. The `<` replacement stays beside each sink with its invariant comment. The chart derivation stays plain TypeScript.
- [ ] 2.4 Retire each escape helper that the runtime covers. Keep only what a sink still needs, and state why it stays.

## 3. The tests and the validity gate

- [ ] 3.1 Re-pin the markup tests to the compact JSX output. Prefer a semantic assertion where one serves, and keep the byte-identical double render.
- [ ] 3.2 Add the dev dependencies `html-validate` and `csstree-validator`, and write the gate test: the rendered every-kind page passes the offline HTML validation, and the inline style rules pass the property-syntax validation.
- [ ] 3.3 Write the raw-sink test: a `</script>` sequence in a chart cell reaches the inline JSON in the replaced form, and the page parses whole.

## 4. The gates

- [ ] 4.1 Run `bun run format:file` on each changed source file.
- [ ] 4.2 Run `tsc -p tsconfig.json`, and repair each finding.
- [ ] 4.3 Run the lint on `src/report-render/`, and repair each finding.
- [ ] 4.4 Run the tests of `src/report-render/` only. Do not run the full suite.
