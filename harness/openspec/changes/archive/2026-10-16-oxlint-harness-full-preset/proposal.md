# Proposal

## Why

The epic #611 removes ESLint from the repository: the shared rules live in `@inflexa-ai/oxlint-plugin`, and the one typed rule ESLint still owns, `neverthrow/must-use-result`, now runs through the type check command `inflexa-typecheck` of `@inflexa-ai/typecheck`. prov-kernel moved first (#606) and gives the reference shape. harness is the next subsystem: the full `typescript()` preset gives 9567 reports on it today (`tmp/claude/lint/harness.md` section 3, taken with plugin 0.3.0; the pinned 0.7.0 run is the authoritative list). #609 moves the tools and #607 turns the full preset on with its fixes; this change does both in one unit of work on one branch, because the intermediate state of #609 — every reporting rule turned off with a `turned on in #607` comment — exists only to split review, and the two issues land together here.

## What Changes

- harness installs `oxlint@1.85.0`, `oxlint-tsgolint@7.0.2003`, `@inflexa-ai/oxlint-plugin@0.7.0`, `@inflexa-ai/typecheck@0.7.0` and the `@typescript/native: npm:typescript@7.0.2` alias at exact versions, and removes `eslint`, `@eslint/js`, `typescript-eslint`, `globals`, `eslint-plugin-neverthrow`, the `patchedDependencies` entry and `patches/eslint-plugin-neverthrow@1.1.4.patch` (#609 task 1). `typescript` stays the version 6 line that builds `dist/`.
- `harness/oxlint.config.ts` default-exports `typescript({ env: { node: true } })` in the shape of `prov-kernel/oxlint.config.ts`: the ban of `@inflexa-ai/tsprov` and `@inflexa-ai/tsprov/*` through `restrictedImports`; the `className` ban on `**/*.tsx` in an override that repeats the `restrictedSyntax()` list, because an override replaces the options; `no-console` on `src/**` with the path exemption for `src/lib/console-logger.ts` and its test; `typescript/no-unused-vars` with the four `^_` options; `typescript/switch-exhaustiveness-check` with `considerDefaultExhaustiveForUnions: true`; the vendored `js/recommended` set on `scripts/**/*.mjs` (#609 task 2).
- `typescript/await-thenable` and `typescript/no-confusing-void-expression` are off in the test files only: bun-types types `expect().rejects.toThrow()` as `void`, and the two rules give about 300 false reports there (#609 task 3, the one exemption #607's done-when keeps).
- `tsconfig.json` includes `scripts/**/*.ts`, so the typed rules and the type check command see the scripts with the real types instead of the default-options `error` type (#609 task 4). The build reads `tsconfig.build.json` and stays unchanged.
- `bun run lint` runs `bun --bun oxlint`; `bun run typecheck` runs `inflexa-typecheck`; `harness/typecheck.config.ts` sets `must-use-result` with the `consumers` option `unwrapOrThrow`, `passGate`, `deliverNotice` and `keepSuspendingRefusal` — the same consumer list the patched ESLint wrapper knew. `eslint.config.js` is deleted (#609 tasks 1, 6).
- The six inline directives take their new forms: `no-control-regex` at `src/input-sanitization.ts` becomes `oxlint-disable-next-line`; the four `must-use-result` directives in `src/lib/result.test.ts` and `src/lib/hooks.test.ts` become `typecheck-disable-next-line`, each with its reason (#609 task 7).
- The two reports oxlint finds and ESLint missed are fixed: `no-unsafe-optional-chaining` at `src/workflows/execute-analysis.test.ts:889` and `no-misused-promises` at `src/loop/run-to-terminal.test.ts:58` (#609 task 8).
- `.github/workflows/lint.yml` changes: the job keeps the name `lint (harness)` (because `release-harness.yml:88` and `release.yml:70` wait for it), the ESLint step becomes the oxlint step, the typecheck step runs the type check command under its Node shebang, and the job gains `actions/setup-node` with Node 24, which the command needs (#609 task 9). The root Claude hook of #606 needs no change: it walks up to the nearest `oxlint.config.ts`, so it becomes active for harness on its own.
- Each text that names ESLint or `eslint.config.js` changes: `harness/CLAUDE.md`, `openspec/specs/structured-logging/spec.md` (through this change's delta), `src/lib/result.ts`, `src/sandbox/create-sandbox.ts`, `src/lib/console-logger.ts`, and `lint.yml` (#609 task 10).
- Each test file moves into the `test/` folder of its directory (`test-placement`; 330 files on the branch-start tree, the setup-rig and fixture-runner tests included — the research-era count said 299), with each relative import and each fixture path fixed, and `tsconfig.build.json` excludes `src/**/test` (#607 task 1).
- Each `interface` declaration becomes a `type` alias (`no-interface`; research-era 862 reports, about 825 of them shipping in `dist/*.d.ts`; the pinned run gives the current total) (#607 task 2, **BREAKING** for an embedder that merges a declaration into a harness interface; the release workflow owns the version bump).
- The reports of the other preset rules are fixed in code, largest clusters first: `typescript/no-non-null-assertion` (1902) and `typescript/no-unnecessary-type-assertion` (1253) with `noUncheckedIndexedAccess` decided first (this change keeps it off — design decision 6); `@inflexa-ai/require-assertion-safety` (1068) with a `SAFETY:` comment per cast; `typescript/no-unsafe-type-assertion` (747); `typescript/require-await` (605); `eslint-js/no-restricted-syntax` (603: regex 497, `JSON.parse` 62, timers 44); `@inflexa-ai/no-conditional-spread` (531); and each smaller rule (#607 task 3).
- The true deprecations of `typescript/no-deprecated` are fixed, for example zod `.passthrough()` at `src/sandbox/farm.ts:42` and the AI SDK `type: "text"` part at `src/loop/tool-output.ts:62` (#607 task 4).
- `@inflexa-ai/no-instanceof-error` gets the `allowIn` option for the error helpers (#607 task 5).
- No `off` entry of the move survives: the final `oxlint.config.ts` turns off no preset rule, except the two bun-types rules in the tests (#607 tasks 6 and done-when).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `structured-logging`: the requirement "Harness source is free of console statements" names `harness/eslint.config.js` as the enforcement home of the `no-console` rule; the home becomes `harness/oxlint.config.ts`. The behavior — no `console.*` in `harness/src` outside the console realization, enforced by lint, exempt by path — does not change.

## Impact

- `harness/`: `package.json` and `bun.lock`, new `oxlint.config.ts` and `typecheck.config.ts`, deleted `eslint.config.js` and `patches/eslint-plugin-neverthrow@1.1.4.patch`, `tsconfig.json` (scripts include), `tsconfig.build.json` (test-folder exclusion), `CLAUDE.md`, `src/` (the report fixes of about 9500 sites across about 780 files, the interface-to-type sweep, the deprecation fixes), the 299 test files moved into `test/` folders, the six directives rewritten.
- Root: `.github/workflows/lint.yml` (the harness job). The Claude hook of `.claude/hooks/oxlint-check.ts` needs no edit.
- `openspec/specs/structured-logging/spec.md` through the delta of this change.
- Published surface: the `.d.ts` of `@inflexa-ai/harness` changes — about 825 exported `interface` declarations become `type` aliases — which asks for a version bump at release time; cli pins the published harness version and moves with the next release. In-repo, the cli jobs of `lint.yml` and `test.yml` link the working-copy harness in every run, so the change must keep the cli typecheck and tests green.
- `dist/` bytes: the emitted `.js` files change only where a report asks for a code change (the regex, timer, spread, and deprecation clusters); each sweep that claims to be type-level proves itself against the recorded pre-change `.js` hash list. The `.d.ts` files change through the interface-to-type sweep. `bun run build && bun run smoke` verifies.
