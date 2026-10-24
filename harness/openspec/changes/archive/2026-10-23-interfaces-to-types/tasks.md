# Tasks

Each code pass is a scripted batch sweep. Write the codemod under
`tmp/pi/704-codemod*` at the monorepo root (already git-ignored), run it, then
`bun run format:file` on each changed file from `harness/`. The `interface`
inventory inputs are `tmp/pi/704-merge-surface.tsv` and
`tmp/pi/704-dist-exported-before.tsv`. Never fix a lint report of a rule that
another child of #607 owns.

## 1. Sweep the plain declarations

- [x] 1.1 Write and run one codemod pass that rewrites each `interface` declaration with no `extends` clause under `harness/src/` and `harness/scripts/` (`**/*.ts`, `**/*.tsx`, test files included) to a `type X = { … };` alias, preserving the `export` modifier, generics, JSDoc, and body verbatim. Verify: `grep -rnE '^\s*(export )?interface [A-Za-z0-9_]+(\s|<)' harness/src harness/scripts --include='*.ts' --include='*.tsx' | grep -v 'extends'` lists no remaining plain form, and `bun run typecheck` passes from `harness/`. (Scope correction during apply: the scout missed `scripts/refresh-fixtures.ts:51`; run B converts it under task 3.1.)
- [x] 1.2 Run `bun run format:file` on every changed file. Verify: `git diff --name-only` shows only source files under `harness/src/`, and `bun run lint` still passes (the rule stays off until task 3.1).

## 2. Sweep the `extends` and generic-constraint forms

- [x] 2.1 Rewrite each remaining `interface X extends A, B { … }` to `type X = A & B & { … };` and each empty-body `interface X extends A {}` to `type X = A;`, at every site under `harness/src/` (the scout pass counted 48 `extends` sites, the final diff holds 47 — for example `src/providers/types.ts:188` `ChatProvider extends AgentChat`, `src/auth/types.ts:162` `SpawnSession extends RunSession`, `src/loop/run-agent.ts:109` `SegmentResult extends RunAgentResult`). Read each rewritten site; if a member conflicts across the intersected bases (a `never` property), stop and report it instead of forcing the pass. Verify: `grep -rn 'interface' harness/src --include='*.ts' --include='*.tsx'` returns no declaration, and `bun run typecheck` passes.
- [x] 2.2 Format the changed files and run the test files that this group touched (for example the doubles that implement seam types: `src/tools/report-session/test/*.test.ts`, `src/loop/__fixtures__/scripted-provider.ts` consumers, `src/__tests__/setup/logger.ts` consumers). Do not run the full suite here; task 3.3 runs it once. Verify: 0 failures in each touched test file.

## 3. Turn the rule on and verify the published surface

- [x] 3.1 Delete the `"@inflexa-ai/no-interface": "off"` entry and its `// #704 rewrites each \`interface\` as a \`type\` alias.` comment from `harness/oxlint.config.ts`, and convert the one non-src declaration the scout missed (`interface Difference` at `scripts/refresh-fixtures.ts:51`) to a `type` alias in the file's own style, after a tree-wide grep confirms no other non-src declaration remains. Verify: `bun run lint` passes and `bun --bun oxlint --rules | grep -i no-interface` (or an equivalent probe) shows the rule on from the preset default. (Probe actually used: the preset source at `node_modules/@inflexa-ai/oxlint-plugin/dist/index.js:118` defaults the rule to `"error"`, the override is gone from `oxlint.config.ts`, and run B confirmed a planted `interface` in a scratch file reports while the rule probe was live. `--print-config`/`--rules` print nothing usable in this oxlint version.)
- [x] 3.2 Rebuild the published surface and prove the rename-free sweep: `tsc -p tsconfig.build.json` from `harness/`, then regenerate the exported-symbol list of `dist/*.d.ts` (module, name, kind) and diff it against `tmp/pi/704-dist-exported-before.tsv`. Verify: the only difference is the 790 `interface` rows becoming `type` rows, `grep -rnE '^(export )?(declare )?interface ' harness/dist --include='*.d.ts'` finds nothing, and `grep -c 'export type'` grows by exactly the converted count. (Correction during apply: the reference file was regenerated from a clean build — 3,219 rows — after an incremental rebuild had left six orphan interface rows of deleted modules in it.) Result: 3,219 rows before and after, exactly 790 interface→type pairs, zero rows added or removed, zero interface declarations left in `dist`.
- [x] 3.3 Run the full required suite one time from `harness/`: `bun run lint`, `bun run typecheck`, `bun test`. Verify: all three pass; record the counts in the task file next to this checkbox.
  - Result (2026-10-23): `bun run lint` passes with `@inflexa-ai/no-interface` on from the preset default and zero reports. `bun run typecheck` passes. `bun test` gives 6117 pass / 51 skip / 0 fail across 358 files (71.07 s), identical to the baseline.
