## Why

The renderer builds its markup as hand-joined strings, and a person who restyles the page edits code that does not read as markup. The review of the renderer asked for two assurances: markup that a person can read and change, and a gate that catches an invalid page before it ships. A validation spike proved that `hono/jsx` gives both paths a home with zero new runtime dependencies.

## What Changes

- The markup layer of `src/report-render/` moves to `hono/jsx` components in `.tsx` files. The chart derivation, the reference ledger, the walk, and the problem collection stay plain TypeScript.
- Escaping moves from call-site helpers to the JSX runtime, which escapes each child and each attribute value by default. The escape helpers retire where the runtime covers them.
- The two JSON script sinks keep the rule that replaces every `<` with `\u003c`, and each raw insertion passes through `raw()` from `hono/html`. The runtime gives no script-hardening, thus the rule stays ours.
- `class` is the one attribute convention. `className` compiles silently and rewrites to `class`, thus the code never uses it.
- The toolchain grows two compiler options (`jsx`, `jsxImportSource`), two eslint globs, and a `*.test.tsx` build exclude. The spike proved each diff, and bun reads the JSX config from the tsconfig with no extra setup.
- A validation gate lands in the tests: an offline HTML validation of the rendered page, and a property-syntax validation of the inline style rules. The gate covers the one hole the compiler leaves — an intrinsic element accepts an unknown attribute silently.
- The markup tests re-pin to the compact JSX output. The byte-determinism test and the semantic assertions survive.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `report-render`: the "Escaping is always on" requirement changes — the runtime escapes by default, and the raw-sink rule becomes explicit. A new requirement adds the page validity gate.

## Impact

- Changed code: `src/report-render/` only. The markup files become `.tsx`, and the logic files stay `.ts`.
- Config: `tsconfig.json` (two options, one exclude entry), `eslint.config.js` (two globs). Both diffs come from the spike, and each is inert for the existing `.ts` files.
- Dependencies: no runtime change. `hono` is an installed dependency, and the compiled output imports `hono/jsx/jsx-runtime` and `hono/html`, both declared exports. Two dev dependencies land for the test gate: `html-validate` and `csstree-validator`.
- The published package surface does not change, and the work stays dormant behind the same non-exported functions.
