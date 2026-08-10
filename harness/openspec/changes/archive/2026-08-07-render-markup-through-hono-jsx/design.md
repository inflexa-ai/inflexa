## Context

The renderer under `src/report-render/` is pure and deterministic, and its markup layer builds strings by hand. A validation spike ran `hono/jsx` against the full toolchain of the harness: the build, bun, eslint, and prettier each pass with small config diffs, and the spike recorded the serialization forms. `hono@4.12.30` is an installed runtime dependency, and its escaper covers the same five entities as the hand-rolled helpers.

The spike also found the limits. An intrinsic element accepts an unknown attribute silently, because the element types carry a permissive index signature. `raw()` inserts a string byte for byte, with no script-hardening. The rendered output is compact, with no whitespace between elements.

## Goals / Non-Goals

**Goals:**

- Markup that reads as markup, with the compiler kept: component props and data expressions stay typechecked, and malformed nesting cannot parse.
- Escape-by-default at the runtime level, in place of call-site discipline.
- A test gate that validates the rendered page as HTML and the inline rules as CSS.
- Every guarantee of the renderer survives: purity, determinism, the `Result` channel, and the no-local-asset page.

**Non-Goals:**

- A visual change. The page keeps its current look, and #311 owns the restyle.
- A change to the chart derivation, the ledger, the walk, or the problem collection.
- A runtime dependency change, an export change, or a roster change.

## Decisions

### D1. The markup layer converts, and the logic layer stays

`prose`, `values`, the reference list, the chart container, and the page assembly become `.tsx` components. The chart derivation, the ledger state, the walk, and the validation stay plain `.ts`. The line sits where presentation meets computation, thus the statistics never mix with markup syntax.

### D2. The runtime owns the escaping, and the sinks keep the rule

The JSX runtime escapes each child and each attribute value over the same five entities as the retired helpers. A raw insertion of serialized document data is legal only at the two JSON script sinks, through `raw()`. Each serialized JSON replaces every `<` with `\u003c` first. The spike proved that `raw()` adds no protection of its own, thus the rule stays beside the sinks with its invariant comment. A raw insertion is otherwise legal for a trusted page constant, and for sibling markup that the runtime escaped already.

### D3. `class` is the convention, and `className` is banned

Both compile, and the runtime rewrites `className` to `class` silently. A silent rewrite invites a mixed codebase, thus the code uses `class` only, and an eslint rule refuses the `className` attribute. The Tailwind class strings copy verbatim.

### D4. The validity gate covers the compiler hole

An intrinsic element accepts an unknown attribute, thus a misspelled `src` compiles. The gate closes this at test time: `html-validate` runs offline over the rendered every-kind page, and `csstree-validator` checks each inline style property and value. Both land as dev dependencies, thus the published package ships nothing new.

The HTML validation runs the recommended preset of the validator. When the page design rejects a rule on purpose, the rule turns off in the test, with its reason beside it. Thus the gate stays principled, and each exception is visible and justified.

### D5. The tests re-pin to the compact form, and semantics lead

The JSX output is one compact line with double-quoted attributes and self-closed void elements. A test that pinned hand-built markup re-pins, and where a semantic assertion serves (an element is present, an order holds, a value escapes), the assertion moves to the semantic form. The byte-determinism test survives unchanged in principle: the same inputs give the same compact bytes.

### D6. The toolchain diffs come from the spike

`tsconfig.json` gains `"jsx": "react-jsx"` and `"jsxImportSource": "hono/jsx"`, and its exclude gains `src/**/*.test.tsx`. `eslint.config.js` grows `tsx` in its two file globs. Bun reads the JSX config from the tsconfig, and no bunfig change exists. The options are inert for every `.ts` file, and the spike proved the whole package compiles clean with them.

## Risks / Trade-offs

- [An unknown attribute compiles on an intrinsic element] → the D4 gate validates the rendered page, and the review watches the markup.
- [The caret pin `^4.12.30` floats hono within 4.x] → the compiled output depends on two declared export subpaths only. The escape tests pin the runtime behavior.
- [The compact output makes a page hard to read in a diff] → accepted. A person reads the source components, and the page is a build artifact.
- [The re-pin touches many tests at once] → the re-pin lands in the same change as the conversion, thus no green-but-stale state exists between commits.

## Migration Plan

The change lands on the same branch as the renderer, thus the open pull request ships the final form. The conversion is file-by-file inside `src/report-render/`, and the gates run after each group. A revert is the branch revert.

## Open Questions

- None. The component names and the file split are implementation details.
