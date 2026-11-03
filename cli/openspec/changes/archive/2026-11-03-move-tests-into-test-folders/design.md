# Design

## Context

See `proposal.md` for the reason. These facts shape the approach:

- The rule source is `node_modules/@inflexa-ai/oxlint-plugin/dist/rules/test-placement.js`.
  A file whose path matches `\.test\.[jt]sx?$` passes only when the base name of its
  parent directory is `test`. A nested `test/sub/x.test.ts` fails. The cli
  configuration gives the rule no options.
- Each test file of cli is under `cli/src`. No directory named `test` exists in cli
  at the base, thus no move merges into an existing folder.
- The fixture folders are not test files: `src/modules/prov/__fixtures__/`,
  `src/modules/sbom/__fixtures__/`, and `src/modules/libs/test-fixtures/`.
- No test imports a different test file. No non-test file imports a test file.
- No test uses `import.meta.url`, `__dirname`, `mock.module`, a snapshot file, or a
  relative `require`.
- Some tests compute a path from `import.meta.dir`, and a wrong depth fails only at
  run time. The sites are in `src/cli/agent_policy_tree.test.ts`,
  `src/cli/gen_docs.test.ts`, `src/lib/env.test.ts` (inside a child process),
  `src/modules/harness/inflexa_tool.test.ts`, `src/modules/infra/setup.test.ts`,
  `src/modules/prov/kernel_compat.test.ts`, the `src/modules/libs/` tests that read
  `test-fixtures/` or a path outside cli, and `src/server/routes/store.test.ts`.
  `src/modules/sbom/spdx.test.ts` imports a JSON fixture with a relative specifier.
- Some tests hold relative path strings that are data, not locations of the test.
  The largest case is `src/client/import_boundary.test.ts`: it writes import text
  into scratch files through `src/test_support/oxlint.ts`. The scratch scope is
  relative to the cli root, and the helper does not move. Thus the move does not
  change these strings or the scratch paths.
- The base is `ea61f71f`. Its CI run of `bun test` in cli (PR #813) gives 4659 pass,
  1 skip, 0 fail, 16967 `expect()` calls, and 4660 tests in 227 files.

## Goals / Non-Goals

**Goals:**

- Each test file moves, and each moved test runs the same assertions against the
  same targets as before.
- The rule turns on with no `off` entry and no inline disable.

**Non-Goals:**

- No fix of a report of a different rule. Each later issue of #608 does that.
- No change of the content of a test, with these exceptions: the relative paths,
  the shared fixture constant of D4, the path comments of D7, and the formatter
  result of D8.
- No edit of the archive of OpenSpec changes, of the tasks of the completed change
  `bind-knowledge-plane`, or of the dated audit `docs/audit.md`. These are records
  of a past state.

## Decisions

### D1. The move adds one directory level, and each relative path keeps its target

`src/<dir>/foo.test.ts` moves to `src/<dir>/test/foo.test.ts`. Each relative module
specifier gains one `../`: `./x.ts` becomes `../x.ts`, and `../x.ts` becomes
`../../x.ts`. Each `import.meta.dir` path gains one `..` segment. The forms in scope
are each static import, `import type`, side-effect import, export-from, dynamic
`import()`, and import with an attribute.

Alternative: change each import to the `@/*` alias of `tsconfig.json`. Rejected,
because no test uses the alias today, and it changes the form of each import line.
The harness move (commit `ba5e6528`) also kept the relative form.

### D2. The test files of `src/test_support/` move into `src/test_support/test/`

The rule names no exception for a test of the shared test support. Thus
`harness.test.ts`, `server.test.ts`, and `render.test.tsx` move like each other test.
The helpers of `src/test_support/` stay, because they are not test files.

Alternative: an inline disable for each of these files. Rejected, because nothing
forces these files to stay. The rule keeps a disable for a file that cannot move.

### D3. The fixture folders stay where they are

A fixture folder is not a test file, and the rule does not apply to it. The moved
tests read each fixture through a path with one more `..`.
`src/modules/libs/test-fixtures/` serves the tests of `src/modules/libs/` and
`src/server/routes/store.test.ts`. Thus a move into one `test/` folder would not
fit each reader.

### D4. One shared constant takes the place of the repeated fixture path

The shape `join(import.meta.dir, "test-fixtures", "farm-parity")` occurs in
`composition.test.ts`, `packages.test.ts`, `store.test.ts`, and
`store_flight.test.ts` of `src/modules/libs/`. `src/server/routes/store.test.ts`
computes the same folder from its own depth. Each site computes the path from the
depth of the test, thus each site must change when a test moves.

The new file `src/test_support/fixtures.ts` exports `FARM_PARITY_FIXTURE`, the
absolute path of `src/modules/libs/test-fixtures/farm-parity`. Each of the five
tests imports it, and its local `FIXTURE` constant goes away. The fixture folder
stays (D3). `composition.test.ts` says that the pool is "checked in beside this
file". After the move, this text is false. Thus the location goes into the JSDoc of
the constant.

The loop rule of the stack says: "Where one shape repeats, make the abstraction
that removes the shape". The independent artifact audits agreed on this point:

- Codex asked for the shared helper.
- Pi accepted a pure move only as an explicit exemption from that rule.
- The coordinator asked for a consensus.

The constant removes the exemption.

Alternative: a pure move, with one more `..` at each site, as the harness move did.
Rejected, because it keeps the repeated shape against the loop rule. Each other
`import.meta.dir` path occurs once, thus it gets the one-level edit of D1 and no
abstraction.

### D5. A scripted rewrite that edits module specifiers only, with a resolution check

The implementor writes one repeatable batch script. The script moves the files of a
directory cluster and rewrites only the module specifiers of D1. The
`import.meta.dir` sites are few, and each one gets a reviewed edit. A plain text
replace of each `"./` or `"../` string is not permitted, because it changes the
data strings of `src/client/import_boundary.test.ts` and other tests.

The check: for each moved file, each relative specifier resolves to the same
absolute file as before the move. A specifier that does not resolve is a defect.
After each cluster, a search finds each `import.meta.dir` site of the moved files,
and the implementor confirms its target.

### D6. The lint configuration changes in two places only

The `"@inflexa-ai/test-placement": "off"` entry and its `// #804` comment go away.
The `excludeFiles` list of the `process.env` override names three test files:
`src/lib/env.test.ts`, `src/lib/credential.test.ts`, and
`src/test_support/harness.test.ts`. Each one gets its `test/` path. The other
overrides use globs such as `**/*.test.{ts,tsx}`, and these do not depend on the
depth. `typecheck.config.ts`, `bunfig.toml`, `package.json`, `tsconfig.json`, and
the CI workflows name no test file, thus they do not change.

### D7. The live text gets the new paths, and the records keep the old paths

Each directory-qualified path to a moved test changes in the live text:

- `CLAUDE.md` (also `AGENTS.md`, which is a symbolic link to it)
- the requirements of `fuzzy-scoring` and `theme-system`, through the spec deltas
- each directory-qualified test path of `docs/color_contrast_audit.md`, because
  each one names a test that enforces the contrast matrix today
- the comments in the moved tests
- the comments in `src/test_support/contrast.ts`, `src/test_support/server.ts`, and
  `scripts/gen_docs.ts`

A bare file name, for example `agent_policy_tree.test.ts`, stays correct and does
not change. The records that the Non-Goals name keep their old paths. `scripts/build.ts`
names a harness test (`runtime/otel-smoke.test.ts`), not a cli test, thus it does
not change.

### D8. Each moved file goes through the formatter

`cli/CLAUDE.md` tells a contributor to run `bun run format:file` on each changed
file of `src/`. Thus each moved file goes through prettier. At the base, the only
test file that prettier changes is `src/server/routes/machine.test.ts`: one
statement at line 848 wraps. This change accepts that one wrap. An import line that
passes the print width of 160 after the extra `../` wraps too.

### D9. The size is standard, and the apply phase uses batch passes

The change adds a capability spec and carries the decisions above, thus it is not
a mechanical change in the workflow sense. The move itself is one transformation,
thus the apply phase runs the batch script of D5 over a small number of large
directory clusters.

## Risks / Trade-offs

- [A wrong `import.meta.dir` depth fails only at run time] → The cluster test run
  after each pass reads each such file. The suite must keep the base counts.
- [`src/cli/gen_docs.test.ts` writes `dist-docs/` under the computed cli root] → If
  the depth is wrong, the test writes a `dist-docs/` folder in `src/`. After its run,
  a search for `src/dist-docs` and `src/cli/dist-docs` must find nothing.
- [The `src/lib/env.test.ts` child imports `env.ts` by a computed path] → A wrong
  path shows as a child failure. Its test runs after the pass of `src/lib/`.
- [The parity tests of `src/modules/libs/` read paths outside cli] → They throw on a
  missing path and never skip, thus a wrong depth fails the test.
- [Formatter wraps add lines to the diff] → Git rename detection still pairs each
  moved file with its source, because the content stays the same.
- [A local run can skip a different number of tests than CI] → The close-out run
  compares its counts with the base. Each difference in the skip count gets an
  explanation.
- [The local `expect()` count can differ from CI] → The Linux CI runner gave the
  base counts, and the close-out run is on macOS. A
  content diff of each moved test against the base shows that no assertion
  changed. The `test (cli)` job of the pull request compares the count with the
  base in the same environment.
