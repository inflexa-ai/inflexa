# Tasks

## 1. Config flip, worklist, deprecations, carried sites

- [x] 1.1 Remove the whole `#609` off-block from `oxlint.config.ts` and wire
      `instanceofErrorAllowIn` into the `typescript()` call with the modules
      that normalize an arbitrary thrown value into an `Error` (start from
      the `Result`/error bridges of `src/lib`; each entry states the reason
      in the config comment). The bun-types test-glob block stays untouched.
      Run `bun --bun oxlint --format json` once and record the fresh
      per-rule, per-directory counts into
      `openspec/changes/adopt-remaining-preset-rules/notes.md` as the live
      worklist (the probe counts of design Context are the plan, the live
      run is the authority). A red `bun run lint` is the sanctioned
      mid-state of design D1. Verify: `bun --bun oxlint` runs and the
      worklist is in `notes.md`
- [x] 1.2 Fix the `typescript/no-deprecated` population (38 measured) per
      design D2: the zod `.passthrough()` set (led by `src/sandbox/farm.ts`)
      moves to `z.looseObject()`, the zod `.url()`/`.date()`/`ZodIssueCode`
      sites move to the live zod API, and the AI SDK `type: "file"`,
      `system`, and `fullStream` sites move to the live AI SDK API, with the
      module tests pinning the semantics. Fix the three non-test bun-types reports
      (`src/tasks/data-profile.ts`, `src/memory/conversation-display-recorder.ts`)
      and the three carried `typescript/restrict-plus-operands` sites (the
      `grouped += digits[index]` read of `src/report-render/number-format.ts`
      and the two `field += ch` reads of
      `src/report-model/production-resolver.ts`) per design D4: the
      bounded-read form, with the produced string unchanged.
      Verify: `bun --bun oxlint src scripts` reports nothing for the four
      rules, and the module tests of each changed file pass

## 2. no-base-to-string

- [x] 2.1 Fix each report of `typescript/no-base-to-string` outside the
      test globs (98 sites measured: 95 in non-test `src` and 3 in
      `scripts/refresh-fixtures.ts`) per design D2: the named property, a
      template of strings, or `JSON.stringify` for a record logged as data;
      a `toString()` override only for a real domain string form. Verify:
      `bun --bun oxlint src scripts` reports nothing for the rule outside
      test files, and the module tests of each changed file pass
- [x] 2.2 Fix each report of the rule in test files (143 sites measured)
      with the same shapes. Verify: `bun --bun oxlint` reports nothing for
      the rule, and the module tests of each changed file pass

## 3. Schema and guard family

- [x] 3.1 Fix each non-test report of `@inflexa-ai/no-empty-schema` (49),
      `@inflexa-ai/no-typeof-object` (52), and
      `@inflexa-ai/no-unknown-type-guards` (59) per design D2, and make the
      deliberate-site zones of design D3 for what must stay (the ledgered
      predicates `isUnknownArray` and the `isRecord`/`isRecordOf` family —
      `isChatPartRecord` reports nothing under plugin 0.8.0 because its
      parameter is typed, so it needs no zone — and the deliberately open
      `z.unknown()` envelopes such as the submit-synthesis input schema of
      `src/execution/run-synthesis.ts`): one zone block per rule with a reason
      per file in the config comment, and the line-level kept-site record of
      design D3 in `notes.md`. Verify: `bun --bun oxlint
    src scripts` reports nothing for the three rules outside test files
      and outside the zone list, and the module tests of each changed file
      pass
- [x] 3.2 Fix each report of the three rules in test files (57, 35, 25
      measured), with test-side deliberate predicates joining the zone list
      or narrowing what they check. Verify: `bun --bun oxlint` reports
      nothing for the three rules, and the module tests of each changed
      file pass

## 4. instanceof-error and return types

- [x] 4.1 Fix each report of `@inflexa-ai/no-instanceof-error` (80
      measured: 68 outside the test globs, 12 in test files): check the specific class, or narrow structurally the
      `isProviderError` way; the modules whose job is normalizing an
      arbitrary thrown value stay in `allowIn` and each other site is
      fixed (the count holds the two `scripts/refresh-fixtures.ts` sites).
      Verify: `bun --bun oxlint src scripts` reports nothing for the rule
      outside the `allowIn` modules, and the module tests of each changed
      file pass
- [x] 4.2 Write the return type of each non-test function that
      `typescript/explicit-function-return-type` names (89 measured; the
      factory keeps the rule off in test files). Verify: `bun --bun oxlint
    src` reports nothing for the rule, and the module tests of each
      changed file pass

## 5. unbound-method, restrict-template-expressions, and the tail rules

- [x] 5.1 Fix each report of `typescript/unbound-method` (52, of which 42
      in tests) and `typescript/restrict-template-expressions` (66) per
      design D2. Verify: `bun --bun oxlint` reports nothing for the two
      rules, and the module tests of each changed file pass
- [x] 5.2 Fix each report of the tail rules per design D2 —
      `no-misused-spread` (33), `no-unnecessary-type-conversion` (30),
      `export-at-declaration` (22), `prefer-promise-reject-errors` (13),
      `no-redundant-type-constituents` (10), `no-unnecessary-type-arguments`
      (10), `no-invalid-void-type` (8), `no-unnecessary-type-parameters`
      (7), `no-useless-default-assignment` (7),
      `no-unnecessary-boolean-literal-compare` (7), `no-dynamic-delete` (5),
      `only-throw-error` (5), `no-unnecessary-template-expression` (4),
      `no-duplicate-type-constituents` (3),
      `use-unknown-in-catch-callback-variable` (2). Verify: `bun --bun
    oxlint` reports nothing for these rules, and the module tests of each
      changed file pass
      (done: all fifteen tail rules report 0 over the whole tree; the 5.2
      outcome is recorded in notes.md)

## 6. Residual sweep and full gates

- [x] 6.1 Do the design D3 residual audit: read each inline directive, zone
      entry, and `allowIn` entry, make sure each carries its reason and
      names exactly one rule, and make sure the kept-site list in `notes.md`
      names each kept occurrence by file and line.
      Run `bun run format:file` on each changed `src/` file. Verify:
      `bun run lint` passes with zero reports, `bun run typecheck` passes,
      and the full `bun test` passes one time
      (done: audit record in notes.md; lint 0 reports, typecheck pass, and
      6163 pass / 51 skip / 0 fail; no `src/` file needed a residual edit,
      so no format run was due)
- [x] 6.2 Run the cross-stack gates against the linked harness: from
      `cli/`, `bun run harness:local`, then `bun run typecheck` and
      `bun test`. Verify: both cli gates pass against the working-copy
      harness
      (done: harness:local build + link exit 0; cli typecheck pass; cli
      bun test 4131 pass / 2 skip / 0 fail)
