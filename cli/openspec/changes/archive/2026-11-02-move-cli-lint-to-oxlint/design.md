# Design

## Context

`cli/` lints with ESLint 10 (`eslint.config.js`, 323 lines) and a patched `eslint-plugin-neverthrow`; `harness/` and `prov-kernel/` already lint with `oxlint` + `@inflexa-ai/oxlint-plugin` + the `inflexa-typecheck` command. Issue #610 moves the tools only: every ban of `eslint.config.js` survives, each preset rule that has reports is off pending the child issues of #608. The model is the merged harness stack (#711): `harness/oxlint.config.ts`, `harness/typecheck.config.ts`, the `lint`/`typecheck` scripts, and the `lint (harness)` CI job.

Facts that shape the design (verified on this branch):

- `@inflexa-ai/oxlint-plugin-solid` 0.8.0 exports `solid(options)`: `typescript(options)` plus `eslint-plugin-solid` 0.18 as a JS plugin, the rules of `eslint-plugin-solid/configs/typescript` on `**/*.{ts,tsx}`, and `solid/prefer-show`. `TypescriptOptions` carries `env`, `tests`, `syntax`, `restrictedImports`, `instanceofErrorAllowIn`, `overrides`.
- `restrictedSyntax({ forEach, jsonParse, timers, regex })` returns the ban entries; `false` drops one. 0.8.0 has no NODE_ENV entry — cli writes its own.
- An override that re-declares `eslint-js/no-restricted-syntax` replaces the entry list, so every override that adds an entry restates the whole set with the same exclusions (the harness `**/*.tsx` override is the model).
- `inflexa-typecheck` reads `typecheck.config.ts`; `typecheck()` turns on `no-generated-empty-object-type` by default, and repository overrides decide the rest. Its directive spelling is `typecheck-disable-next-line <rule> -- <reason>`; a directive without a reason or without effect is itself an error. It does not read `oxlint-disable` lines.
- `cli/tsconfig.json` already has `"lib": ["ESNext", "DOM"]`, so the JSX error-type trap the probe found is gone.
- `src/client/import_boundary.test.ts` and `src/cli/agent_policy_tree.test.ts` drive the ESLint Node API against the real flat config to pin the client import boundary and the `.action(` ban. They must be ported, not deleted: the loop rule says a lint change must not make a test weaker.
- The dynamic `dev/` imports are two sites now: `src/cli/index.ts:384` (`dev/run.ts`) and `:405` (`dev/chat.ts`).

## Goals / Non-Goals

Goals: tool parity — each report ESLint's solid rules gave (zero) stays zero, each ban stays armed, `bun run lint`, `bun run typecheck`, `bun run docs:gen` and the tests pass in `cli/`, and the harness/prov-kernel lint jobs stay green.

Non-Goals: turning any reporting preset rule back on (child issues #804–#811), the formatter (prettier stays), any product behavior change, the `skip_specs` route (spec deltas exist).

## Decisions

### D1 — The factory call

`oxlint.config.ts` default-exports `solid({ env: { browser: true }, syntax: { regex: false, jsonParse: false, timers: false }, overrides: [...] })`. No `version` option: cli runs solid-js 1 and the plugin applies Solid 1 semantics when the setting is absent, exactly as the ESLint config did. The three `syntax` switches carry a comment naming #808; `forEach` stays on (it reports nothing). The opentui renderer bans (D3) and the NODE_ENV entry ride as repository entries.

### D2 — The carried bans, one override each

- NODE_ENV, all files: an override on `**/*.{ts,tsx,js,mjs}` restating the shared set — `Object.values(restrictedSyntax({ regex: false, jsonParse: false, timers: false }))` with each `false` entry dropped, as the factory itself does (a `false` entry is not a valid rule option) — plus the NODE_ENV selector from `eslint.config.js` (message unchanged). The two sanctioned reads keep their inline directives, rewritten (D6).
- `.action(` ban: an override on `src/cli/**` with `excludeFiles: ["src/cli/agent_policy.ts"]`, restating the D2 list plus both `.action(` selectors (plain and computed member).
- `process.env` reads: native `no-restricted-properties` on `src/**` with `excludeFiles` for the six sanctioned files (re-verified against the current `eslint.config.js` ignores list: `src/lib/env.ts`, `src/lib/env.test.ts`, `src/lib/credential.test.ts`, `src/test_support/preload.ts`, `src/test_support/sandbox.ts`, `src/test_support/harness.test.ts`).
- `dev/` imports: native `no-restricted-imports` on `src/**` with `excludeFiles: ["src/modules/harness/dev/**"]` and the `**/dev/*`, `**/dev/**` group pattern. oxlint visits dynamic `import()` where ESLint did not, so the two lazy gates in `src/cli/index.ts` take `oxlint-disable-next-line no-restricted-imports -- <reason>` directives; the file keeps the ban against static imports, which is the guard a release build would actually evaluate.
- Client import boundary (the block that postdates the issue draft, added with the TUI/server split): the native `no-restricted-imports` of oxlint 1.85.0 cannot carry it. A `regex` pattern with a lookahead never matches and gives no config error (verified with a probe on this machine), and two of the five patterns are allowlists that need a lookahead (the harness runtime, and the modules allowlist). Thus the boundary moves to `eslint-js/no-restricted-syntax`: one entry for each of the five patterns, with the same regex and message, as a selector over the `source.value` of `ImportDeclaration`, `ExportNamedDeclaration`, `ExportAllDeclaration`, and `ImportExpression`, plus the cooked text of the first quasi of an `import()` whose source is a template literal (a template literal has no `value`, so `` import(`../server/app.ts`) `` would pass the `source.value` selector) (esquery 1.7.0 takes an escaped `\/` and a lookahead in a selector regex; verified with the same probe). An `import type` is an `ImportDeclaration`, so the type-only import stays banned. The five entries form one list that the override on `src/tui/**` and `src/client/**` (test files included — a TUI test drives the client) restates beside the shared set; the D3 override restates it too. The `dev/` pattern stays in the `src/**` `no-restricted-imports` override, which these files keep, so it needs no restatement. The dynamic form is new coverage, and it reports nothing today: the one lazy client import of a module (`src/tui/commands.tsx:2893`) names the allowed `modules/prov/verify_file.ts`. The ported boundary test (D7) pins the mechanism.
- `typescript/no-unused-vars` with the four `^_` options and `typescript/switch-exhaustiveness-check` with `considerDefaultExhaustiveForUnions: true`: one override on `**/*.{ts,tsx,js,mjs}`, as harness does.
- The `scripts/` typed-rule exclusion dies: `tsconfig.json` includes `scripts/**/*`, so the typed promise rules apply to scripts (the probe measured zero reports there). The stale `eslint.config.js:112-114` comment is not carried.
- No replacement is needed for the old `ignores: ["**/.inflexa/"]`: oxlint honors `.gitignore`, and the root `.gitignore` lists `.inflexa/` (the old flat ESLint config was the thing that did not read it). A local run with a minted `.inflexa/` confirms this during implementation.

### D3 — The opentui renderer bans

One override scoped to the non-test files of `src/tui/**` (`excludeFiles: ["**/*.test.{ts,tsx}"]`), placed after the boundary override, restating the shared set and the boundary entries (D2) plus the two new entries — an override replaces the entry list, so a tui-only list would silently drop NODE_ENV, `forEach`, and the boundary for every TUI file. The override order is: all files (shared set), `src/cli/**` (shared set and `.action(`), `src/tui/**` and `src/client/**` (shared set and boundary), non-test `src/tui/**` (shared set, boundary, and the renderer bans). The entries:

- Hex color: a literal whose whole value, without the surrounding white space, is a hex color — `#` and 3, 4, 6, or 8 hex digits. The regex is `/^\s*#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\s*$/`, over `Literal[value=…]`, `TemplateElement[value.cooked=…]`, and `JSXText[value=…]`. The template entry reads the cooked text, so an escape such as `` `\x23fff` `` or `` `\u2713` `` cannot slip past the ban. The anchor keeps prose such as "step #12 of 40" out of the ban, and a color value is always a whole string (an `fg`/`bg` prop, a `RGBA.fromHex` argument). The palette source is `src/lib/design_system.ts`, outside the scope, so no file exemption is needed for it; tests are excluded because they assert on resolved colors.
- Glyph: a literal holding a non-ASCII character that is not sanctioned prose punctuation — the em dash, the ellipsis, the middle dot, and the right arrow (`\u2014`, `\u2026`, `\u00B7`, `\u2192`) — over the same three node kinds. The regex is `/[^\x00-\x7F\u2014\u2026\u00B7\u2192]/`. The four are the typographic punctuation the tree's prose already carries; the ban targets shape glyphs (a check mark, a triangle, a caution sign), which belong to `GLYPHS`. ASCII `>`/`<` markers are ASCII and cannot match.

The mechanism is verified, not assumed: a probe on this machine against the pinned oxlint 1.85.0 with the `eslint-js` JS-plugin alias fired each selector on a hex literal, a template text, a JSX text child, and a `✓` literal, and stayed silent on a prose line carrying all four punctuation marks. Verification during implementation stays two-sided: the lint run reports nothing on the current tree (the tree's non-ASCII literals outside comments are exactly the sanctioned punctuation, verified), and a mutation probe (a scratch hex string literal, a hex template text, a hex JSX text child, and a scratch `✓` in one TUI file, lint that file, revert) proves the entries still fire. The message of each entry names the sanctioned channel (`theme()`, `GLYPHS`), and the Glyphs section of `cli/CLAUDE.md` names the punctuation exemption set.

### D4 — The type check command and the four sites

`typecheck.config.ts` default-exports `typecheck({ overrides: [...] })`:

- `files: ["src/**"]`, `must-use-result: ["error", { consumers: [...] }]`. The consumers are the two receivers the command newly flags, each with a comment that states why it is a consumer: `fromCatalogStart` (`src/server/routes/store.ts:186`, takes `Result<CatalogTransferStart, StoreDownloadError>`) and `readImageSbom` (`src/modules/sbom/sbom.ts:93`, takes `Result<ContainerRuntime, ContainerRuntimeError>`). Both already handle their Result; no product code changes.
- `files: ["**/*.test.{ts,tsx}"]`, `must-use-result: "off"` with a comment naming #810.
- The two yields in `src/client/api.ts` (`yield err(chunk.error)`, `yield parseFrame<T>(…)`) are Results consumed by the caller's `for await`, which the rule cannot follow; each takes `// typecheck-disable-next-line must-use-result -- <the same reason the eslint-disable carried>`.
- If the default `no-generated-empty-object-type` block reports on cli, it is turned off in an override with the #811 comment (a preset rule with reports, same policy as D5).

`bun run typecheck` becomes `inflexa-typecheck`; `bun run lint` becomes `bun --bun oxlint`, as in `harness/package.json`. The devDependencies take the harness shape: `"@typescript/native": "npm:typescript@7.0.2"` beside `"typescript": "^6.0.3"`. The README of `@inflexa-ai/typecheck` 0.8.0 asks for the alias at the exact version of its own dependency, so that the install holds one TypeScript 7; `typescript` stays TypeScript 6 for the editor. `@inflexa-ai/oxlint-plugin` 0.8.0 is a direct devDependency too, because `oxlint.config.ts` imports `restrictedSyntax` from it and the README of the solid package asks for it beside the solid package.

### D5 — The turn-off pass

Method: the measurement runs AFTER the directive rewrite of D6 — oxlint ignores `eslint-disable` lines (`respectEslintDisableDirectives: false`), so measuring first would count every directive-suppressed site (the NODE_ENV reads, the `process.env` blocks, `solid/reactivity`, `no-explicit-any`) as reports and disarm carried bans. With the directives rewritten, run `bun --bun oxlint` with the preset on, collect the per-rule report counts, and write the `off` entries in one final override on `**/*.{ts,tsx,js,mjs}` (the harness model; it comes after each other override), one line per reporting rule, grouped by child issue, each group with a comment naming the child issue of #608 that owns it:

- `@inflexa-ai/test-placement` → #804
- `typescript/no-unsafe-*`, `@inflexa-ai/no-conditional-spread` → #805
- `@inflexa-ai/require-assertion-safety`, `typescript/no-unsafe-type-assertion`, `@inflexa-ai/no-double-cast` → #806
- `typescript/no-non-null-assertion`, `typescript/no-unnecessary-type-assertion`, `typescript/no-unnecessary-condition` → #807
- the restricted syntax `regex`, `jsonParse`, `timers` → #808 (the D1 `syntax` switches and the matching restatements)
- `typescript/require-await` → #809
- each remaining rule (including any solid rule new in 0.18, `solid/prefer-show`, `no-generated-empty-object-type`) → #811

A rule that the ESLint config already ran never takes an `off` entry, the harness model (decisions 3 and 7 of its archived move). The set is `js/recommended` of ESLint 10, `tseslint.configs.recommended`, the hand-set typed rules (`no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `no-unused-vars`), the rules of `eslint-plugin-solid/configs/typescript` 0.14.5, and the carried bans. oxlint can report a site that ESLint did not (the probe shows `no-unsafe-optional-chaining` and `typescript/no-misused-promises` in tests, `no-useless-assignment` in `src`). Each such site is fixed in place, with no behavior change and no weaker test: for example an explicit presence assertion before a non-optional access, or a comma expression unwrapped into a block body. A site that is a false report of oxlint takes an `oxlint-disable-next-line` directive with its reason. The `off` entries are only for rules that ESLint did not run.

The one permanent exception, mirroring harness and #608's approach item: `typescript/await-thenable` and `typescript/no-confusing-void-expression` are off for the test globs because bun-types types the assertion results as `void`; that comment names bun-types, not a child issue. A rule that reports nothing stays on — the turn-off list is measured, not copied from the probe (the tree moved since 2026-09-28).

### D6 — The directive rewrite

Every `eslint-disable*` line in `src/` and `scripts/` is rewritten in place, keeping each reason:

| Old | New |
| --- | --- |
| `eslint-disable[-next-line] solid/reactivity` | `oxlint-disable[-next-line] solid/reactivity` |
| `eslint-disable @typescript-eslint/no-explicit-any` | `oxlint-disable typescript/no-explicit-any` |
| `eslint-disable no-restricted-properties` | `oxlint-disable no-restricted-properties` |
| `eslint-disable-next-line no-restricted-syntax` | `oxlint-disable-next-line eslint-js/no-restricted-syntax` |
| `eslint-disable solid/style-prop` | `oxlint-disable solid/style-prop` |
| `eslint-disable[-next-line] neverthrow/must-use-result` (tests) | deleted — the rule is off in the test globs (D4), so the directive is dead text |
| `eslint-disable-next-line neverthrow/must-use-result` (`src/client/api.ts`) | `typecheck-disable-next-line must-use-result` (D4) |
| `eslint-enable` | `oxlint-enable` |

Two checks prove the rewrite: a text search for `eslint-disable` and `eslint-enable` in `src/` and `scripts/` finds nothing (oxlint ignores the old spelling, so the lint run cannot see a leftover), and `reportUnusedDisableDirectives: 'error'` (the factory default) fails the run on a new directive that suppresses nothing, for example a wrong rule name.

### D7 — The two ported tests

Both keep their case lists verbatim and swap the engine: instead of `new ESLint(...).lintText(...)`, they spawn `bun --bun oxlint` from `cli/` with the real `oxlint.config.ts`. The pinned oxlint 1.85.0 rejects `--stdin`, so the plan of record is the scratch file: the test writes each snippet to a uniquely named file in a fresh scratch directory under each scope that a case names (`src/tui/`, `src/client/`, `src/server/`, `src/cli/`), lints, and removes each directory in a `finally` — the glob-relative path is what makes the override apply, and the directory must not match a `.gitignore` entry, because oxlint skips an ignored path. All snippets of one suite go through one spawn (one process per suite, not per case), which receives each scratch path as a lint target. The spawn runs the type-aware program, so each test that waits on it sets an explicit timeout that holds under full-suite load. The `.action(` test keeps the plain and computed-member cases, and its exemption case: it lints the real `src/cli/agent_policy.ts`, which holds the sanctioned `command.action(handler)` call, and asserts that the ban reports nothing there (a scratch file cannot take that path, because the file exists). The boundary test keeps its banned and allowed specifier lists, the type-only case, the `./dev/` case, and the server-side case, including the harness contracts allowance. Each test reads the reports of the rule id that carries its ban only — `eslint-js/no-restricted-syntax` for the boundary and `.action(`, `no-restricted-imports` for the `./dev/` case — and it fails loudly when the spawn exits with a config error, so a broken config cannot pass as "no report".

### D8 — CI and release

`.github/workflows/lint.yml`, cli job: the name `lint (cli)` stays (`release.yml` waits for that check name); the link step stays before lint (tsgolint reads the linked types); a `setup-node` step (node 24, the harness job's pin and comment) is added because `inflexa-typecheck` runs under its Node shebang; each ESLint mention in the file changes — the `ESLint` step name, the header comment (lines 3-10), and the "Same category as ESLint" comment above the docs step. `release.yml` also gains the same `setup-node` step in the job that runs `bun run typecheck` against the npm pins: that job runs the new Node-shebang command with no Node pin of its own, so without the step the release pipeline breaks on the first version bump after this change.

### D9 — Text updates

`cli/CLAUDE.md` (the `typecheck` and `lint` lines of the Quick Start, the `must-use-result` paragraph — which also says that the rule is off in the tests until #810 — the escape-hatch comment rule, the client import rule (its mechanism and file name: entries of `eslint-js/no-restricted-syntax` in `oxlint.config.ts`, which cover a static import, a re-export, and a dynamic `import()`), the `solid/reactivity` directive spellings, the `dev/` dynamic-import paragraph, the lint CI note, and the Glyphs section's exemption set for the new glyph ban), `cli/README.md:41`, the four spec files, the `lint.yml` header, the two source comments that name ESLint (`src/cli/agent_policy.ts:174`, `src/lib/credential.test.ts:11`), and `.claude/skills/db-ops/SKILL.md:146`, which names the `neverthrow/must-use-result` ESLint rule and says that `isErr()`/`.value` is not consumption (false for the type check command). The archived changes are not edited: an archive records the decision as it was made, and the issue's "active change `home-dev-command-surfaces`" is archived now (`2026-10-05-home-dev-command-surfaces`). The spec `Purpose` line that names ESLint (`result-types`) is edited as an explicit task (5.2), not left to the sync.

### D10 — No new test file for the renderer bans

The two old bans keep their tests (D7). The two opentui renderer bans get no new test file: the repository rules forbid a test file that the issue does not ask for, and the issue asks for the entries only. The two-sided probe of D3 (task 3.3) proves them at implementation time. The accepted trade-off: a later override that drops an entry is caught by review, not by a test.

## Risks / Trade-offs

- [A selector regex of the boundary or of the renderer bans matches less than its ESLint pattern did] → the ported boundary test (D7) and the D3 mutation probe fail on a silent entry; the native `regex` form is not used for a lookahead pattern (D2).
- [esquery regex attribute values behave differently in oxlint's engine] → the D3 mutation probe catches a silent selector; a selector that fires on sanctioned code is tuned to the documented exemptions, not weakened past them.
- [`eslint-plugin-solid` 0.18 reports where 0.14.5 was silent] → a report of a rule of the 0.14.5 `configs/typescript` set is fixed in place (D5, carried rule); a report of a rule that 0.18 adds is an `off` entry with the #811 comment.
- [bun.lock misses the linux platform bindings of oxlint/oxlint-tsgolint for CI] → `bun install --frozen-lockfile` records every optional platform package; the CI run is the proof, and a missing binding is a lockfile regen, not a design change.
- [The turn-off list drifts from the probe counts] → the list is measured on this branch (D5), not copied; the child issues measure again at their own version.

## Migration Plan

One change, no rollout: the scripts, configs, lockfile, directives, tests, CI, and text land together; `bun install` after checkout brings the new pins and drops the patch. Rollback is the inverse commit; no data or API is involved.

## Decisions reached by review consensus

The coordinator, the Codex reviewer, and the Pi reviewer examined these decisions. No reviewer objected to the final form. The PR description carries them.

- The client import boundary moves from `no-restricted-imports` to `eslint-js/no-restricted-syntax` source selectors (D2). oxlint 1.85.0 silently ignores a `regex` pattern with a lookahead, and two of the five patterns are allowlists that need one. The selectors also cover a re-export, a dynamic `import()`, and a template-literal `import()` with no interpolation.
- The two lazy `dev/` imports of `src/cli/index.ts` take an inline `oxlint-disable-next-line no-restricted-imports` directive each (D2). oxlint reads a dynamic `import()`, and ESLint did not. The gate file keeps the guard against a static import.
- `readImageSbom` and `fromCatalogStart` go in the `consumers` option of `must-use-result` (D4). Each already handles its `Result`, so no product code changes.
- The opentui renderer rules of the issue are a hex-color ban and a glyph ban in the non-test files of `src/tui/` (D3). The glyph ban exempts the em dash, the ellipsis, the middle dot, and the right arrow, and `cli/CLAUDE.md` names the same set. The hex ban matches a whole literal value only.
- A rule that the ESLint config already ran takes no `off` entry (D5). oxlint's new reports of such a rule are fixed in place, or take a reasoned directive for a false report (`no-useless-assignment` in `src/tui/hooks/conversation.ts`).
- The `@typescript/native` alias joins the devDependencies, the same as harness (D4).
- `release.yml` gains `setup-node`, because it runs the type check command, which needs Node (D8).
- No new test file pins the renderer bans (D10). The implementation probe proved them.
- The archived changes are not edited, and the `dev-commands` spec keeps "exactly one read" of `NODE_ENV` in application code.

## Open Questions

None.
