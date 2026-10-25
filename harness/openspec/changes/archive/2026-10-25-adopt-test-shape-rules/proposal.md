# Proposal

## Why

Umbrella #607 turns the full oxlint preset on in harness, and the
test-shape rules are the next gate in the stack order (#710, independent
of the other rule-fix issues). Since the #609 move, the two rules sit off
in `oxlint.config.ts` behind the `#710` comment: `typescript/require-await`
and `typescript/no-implied-eval`. Measured with plugin 0.8.0 on this
branch, the forced-on run reports 869 `require-await` sites over 151
files — 835 in the 132 test files, 18 in the 13 non-test source modules,
16 in the 6 `__fixtures__` modules of `src` — and 10 `no-implied-eval`
sites over 6 files, all under `src/report-render/test/`. Each
`require-await` report marks a function that promises asynchrony and
holds none: a test double shaped unlike the function it stands in for, or
a seam realization that wraps a synchronous body in `async`. Each
`no-implied-eval` report marks a test that runs compiled page source
through the `Function` constructor with no stated reason. The counts in
the issue body come from the pre-move snapshot of
`tmp/claude/lint/harness.md`; this change works from the re-measured
numbers.

## What Changes

- Turn the two rules on: the `#710` block of `oxlint.config.ts` — its
  comment and its two `off` lines — goes away. The `off` entries of the
  other children of #607 and the bun-types test-glob exemption stay
  untouched.
- `require-await`: each test double takes the shape of the real function
  it stands in for. A double that returns nothing where the real function
  returns a value gains that return. A function whose type demands a
  promise and that awaits nothing drops `async` and returns
  `Promise.resolve(value)` — or `Promise.reject` where the real function
  rejects. A double passed where a plain value serves drops `async` and
  returns the value.
- `no-implied-eval`: each page script runs from a fixture — a shared
  runner that the report-render tests import — or keeps its site with an
  `oxlint-disable-next-line typescript/no-implied-eval -- <reason>`
  directive that names the reason.
- One pull request for the whole issue, in the #703-to-#708 pattern of
  the stack.

## Capabilities

### New Capabilities

- `test-shape`: the harness oxlint configuration keeps
  `typescript/require-await` and `typescript/no-implied-eval` on — no
  override turns either off — and the source reports nothing for them.

### Modified Capabilities

(none)

## Impact

- `harness/oxlint.config.ts`: the two lines of the `#710` block and its
  comment.
- The 13 non-test source modules with 18 reports: the tool `execute`
  bodies (`report-blocker.ts`, `run-synthesis.ts` ×2,
  `submit-file-metadata.ts`, `generate-plan.ts`,
  `generate-analogy-report.ts`, `data-profile.ts`), the seam
  realizations and stand-ins (`eyes.ts`, `knowledge/index.ts` ×5,
  `approval/contract.ts`), the provider middleware (`ai-sdk.ts`), the
  workflow cancel helper (`suspension.ts`), and the two corpus listings
  (`regulatory-corpus/fetch-fda-guidance.ts`,
  `regulatory-corpus/fetch-ich.ts`). No declared signature changes and
  nothing joins the barrel.
- The 6 `__fixtures__` modules of `src` with 16 reports, and the 132
  test files with 835 reports, led by
  `tools/report-session/test/preview-report.test.ts` 91,
  `sandbox/test/docker-client.test.ts` 72,
  `providers/test/ai-sdk.test.ts` 65,
  `loop/test/run-agent.test.ts` 34.
- The 6 report-render test files with the 10 `no-implied-eval` sites:
  `render.test.ts` ×5, `options.ts`, `hybrid-svg.test.ts`,
  `chart-renderers.test.ts`, `chart-toolbox.test.ts`,
  `table-data.test.ts`.
- The cli cross-gates of the stack: the harness build feeds the linked
  package, and the cli typecheck and test suite must stay green against
  it.
