# Design

## Context

Increment 1 committed the floor 100/20 with a reason that dismissed the reports
below the floor as structural repetition. The fragment review disproved that
dismissal: the bands hold a slug loop family in production files, a chart
prologue three times, staging twins in the scripts, and test scaffolds of the
same class that increment 1 already extracted. See proposal.md — Why. The scan
evidence lives in `tmp/pi/jscpd-recheck/` and stays out of the repository.

## Goals / Non-Goals

Goals:

- The gate at the new floor reports no copy, and each removal names an
  abstraction instead of a per-site edit or an ignore region.
- The slug loop family gets one name, and each call site keeps its policy
  beside the call.
- The floor reason records the measured ladder, per the spec delta.

Non-Goals:

- No floor below 60 tokens. The 60/5 band holds 495 clones, and most of them
  are intra-file test noise that no abstraction wants.
- No unification of the case-preserving normalizers. `dashUnsafeRuns` of
  `preview-report.ts` and `keepFileSafe` of `report-render/assets.ts` keep
  different alphabets and a different case contract, and their doc comments
  state it. `slugify` does not absorb them.
- No new dependency, and no public interface change.

## Decisions

### Decision: the floor moves to 60 tokens and 15 lines

The ladder: 495 clones at 60/5, 214 at 60/10, 48 at 60/15, 44 at 70/15, 0 at
100/20. The 60/15 set holds 5 or 6 production clones and 4 or 5 dozen test
clones, and each of them names a repeated block with an abstraction behind it.
The 70/15 floor hides the `chart.ts` find, because its clone pair spans 17
lines, and the 60/5 floor pulls in parameter tables and zod pyramids that no
abstraction wants. The line floor stays at 15, because the token-dense blocks
below it are type declarations and schema shapes whose repetition carries no
name.

### Decision: one `slugify` for the lowercase slug family, with policy at the sites

`src/lib/slug.ts` exports `slugify(value, opts?)` with
`opts.maxLength` and `opts.fallback`. The loop keeps the exact order of the
operations that the family shares: lowercase, keep `[a-z0-9]`, collapse each
non-allowed run to one dash, stop before the append that would pass the cap,
slice to the cap, and return the fallback when the result is empty. An early
stop cannot change the first characters of the result, because an append only
extends the prefix, so the capped sites stay byte-identical.

- `tasks/data-profile-index.ts` calls `slugify(value, { maxLength:
  SLUG_MAX_LENGTH, fallback: "unnamed" })`; `tasks/data-profile-resolve.ts`
  uses the same cap with the fallback `"group"`.
- `schemas/validate-plan.ts` keeps the exported `deriveOutputPrefix` name, and
  its body calls `slugify(stepId)`.
- `lib/regulatory-corpus/fetch-ich.ts` drops its local `slugify` and imports
  the helper.
- `sandbox/execution-id.ts` keeps the exported `sanitizeAgentName` name, and
  its body calls `slugify(name, { maxLength: AGENT_NAME_MAX_LENGTH })`. The
  execution ID feeds pod and job names, so its test must pass unchanged.
- `tools/display/normalize-echart-spec.ts` keeps its own `kebabFilename` loop.
  Its contract folds diacritics transparently: a combining mark neither ends a
  run nor starts one, so a mark inside a word adds no dash. `slugify` has no
  notion of a transparent character, and a migration would change the download
  filenames that the tests pin.

Alternative considered: one normalizer with alphabet and case options that
absorbs `dashUnsafeRuns`, `keepFileSafe`, and `kebabFilename`. Rejected: the
options object grows four knobs, and the three call sites read worse for it.

### Decision: the chart prologues collapse into two file-local helpers

`deriveBar`, `deriveBox`, and `deriveViolin` share the require-x, require-y,
order-categories prologue. `axesOf(block, rows, columns)` returns
`Result<{ x, y, categories }, RenderProblem>` and serves the three. `deriveBox`
and `deriveViolin` also share the group construction and the slot fault:
`slotGroupsOf(block, rows, categories)` returns the group column, the group
list, and the slot bound. The series and lane construction stays at each
derive function, because the box and the violin build different lanes. The
helpers stay file-local, because only the chart derivations use them.

### Decision: one staging module for the two render scripts

`scripts/stage-report-page.ts` exports `stageReportPage(pageDir, rendered)`:
it makes the assets directory and its `deps` subdirectory, copies each
`PAGE_ASSETS` entry from its installation path, writes each data asset, writes
`index.html`, and returns the page path. The gallery script keeps its
remove-before-staging step and its comment about hash-named data assets at its
call site, because that policy belongs to the gallery alone. The scripts
already import from `src/`, so the helper imports the same asset constants.

### Decision: one emitter for the run-loop tool-event pair

The refusal path and the user-denial path of `run-loop.ts` each emit
`tool-started` and then `tool-finished`. A file-local helper takes the shown
detail, the outcome, and the optional error text, and emits the pair. The
caller states its outcome and its error rule, so the difference between the
paths stays visible at the call sites.

### Decision: the authoring destination fields become one fragment

`addBlockInput` and `moveBlockInput` repeat the four absentable destination
fields with the same descriptions. One `destinationFields` object holds the
fragment, and each schema spreads it into its `z.object`. `changeBlockInput`
keeps its own fields, because it names no destination.

### Decision: the opentargets schemas share a rows envelope

`TargetAssociationsDataSchema` and `DiseaseAssociationsDataSchema` repeat the
`rows` array envelope and the datatype-scores field. A `rowsEnvelope(item)`
combinator and a `scoresField` constant collapse the repetition, and each
schema keeps its own object tree, because the target and the disease shapes
differ genuinely.

### Decision: the test scaffolds join the fixture conventions

Each test cluster gets the smallest shared home that its consumers already
read:

- The client test stubs join `src/tools/lib/__fixtures__/`, beside
  `fixture-runner.ts`.
- The PDF builder joins `src/lib/test/`, because two different tool trees read
  that directory for test helpers already.
- The stream-model builder joins `src/loop/test/`, beside `metric-reader.ts`.
- The report-session tool builders and the tasks context builders live in a
  `__fixtures__` module beside their suites, or stay file-local when one file
  holds every consumer.
- Each cluster keeps the stub behavior of its suites, and the suite runs after
  its move.

### Decision: the acceptance loop runs the real gate

The simulated clone sets come from one scan at 60/5, and the detector merges
and splits regions as its floor moves, so the task list treats the gate, not
the simulation, as the truth: after the extractions, `bun run dupes` runs at
60/15, and each copy it still reports gets its cluster pass, until it reports
none.

## Risks / Trade-offs

- [A slug site drifts in bytes] → Each site runs its existing tests after the
  migration; the data-profile, execution-id, and filename suites pin the
  outputs.
- [The gate set differs from the simulated set] → The acceptance loop runs the
  real gate at 60/15 and fixes what it reports.
- [A refactor of a load-bearing file changes behavior] → The run-loop and
  execution-id helpers stay file-local and minimal, and the loop and sandbox
  suites run after each edit.

## Migration Plan

Not applicable. The change lands in one repository, and the test suite gates
it.

## Open Questions

None.
