# Design

## Context

The repository runs one ESLint config per subsystem, each with a typed program built from a second tsconfig (`tsconfig.eslint.json`) that the build excludes tests from, and no `types` for `bun:test`. The epic #611 moves every subsystem to oxlint with the shared preset of `@inflexa-ai/oxlint-plugin`; oxlint's typed rules (`oxlint-tsgolint`) and the type check command (`@inflexa-ai/typecheck`, `inflexa-typecheck`) both read the nearest `tsconfig.json`, so the program layout must change first (#605 before #606). The local research in `tmp/claude/lint/` holds a full inventory; `prov-kernel.md` section 3 lists each report the full preset gives after the tsconfig swap (about 205, plus one in the probe config itself). The inventory was taken with plugin 0.3.0; this change pins 0.7.0, so the list is a map, and the lint run under the pinned versions is the authoritative report list. The reference repository `himmel` already runs the same packages at the same versions.

## Goals / Non-Goals

**Goals:**

- One `tsconfig.json` per subsystem serves lint, typecheck and the editor; the build reads `tsconfig.build.json`.
- prov-kernel lints with `typescript({ env: { node: true } })` of `@inflexa-ai/oxlint-plugin` and typechecks with `inflexa-typecheck`, with no ESLint dependency left.
- `bun run build` in harness and prov-kernel emits the same `dist/` bytes as before; the golden fixture of prov-kernel does not change.

**Non-Goals:**

- No lint change in harness or cli beyond what the tsconfig work names: their ESLint configs stay, the Solid plugin stays, and the epic steps #609, #607, #610, #608 are out of scope.
- No release, no publish, no version bump of `@inflexa-ai/prov-kernel` in this change; the `.d.ts` surface change is recorded, and the release workflow owns the bump.
- No removal of the neverthrow ESLint wrapper in cli or harness.

## Decisions

1. **The lint program becomes `tsconfig.json`; the build moves out, not the tests.** `tsconfig.json` includes all of `src` with `"types": ["bun", "node"]` (harness and prov-kernel; prov-kernel already has `["node"]`). A new `tsconfig.build.json` extends it with the emit options and the test exclusions (`src/**/*.test.ts`, `__tests__`, `__fixtures__`, and in harness `src/report-render/fixture.ts`, `src/report-render/gallery`; after the test move prov-kernel also excludes `src/test`). `build` and `prepare` run `tsc -p tsconfig.build.json`, so `prepare` keeps emitting — a `noEmit` program would emit nothing and not fail. `typecheck` reads `tsconfig.json`. Alternative rejected: keeping two programs and pointing oxlint at the second — `--tsconfig` changes only import resolution, and the type check command reads the nearest `tsconfig.json` by name.

2. **cli adds `"DOM"` to `lib`.** `solid-js` types `JSX.Element` with the DOM `Node`, and the probe (`tmp/claude/lint/cli.md` section 3) shows `"DOM"` removes about 500 false typed reports. The alternative, an ambient `Node` declaration, is unprobed and fakes a global. The cost — cli code can now type-check against `window`/`document` — is accepted; the cli subsystem leaves the strict `no-unsafe-*` rules off until #610 anyway.

3. **prov-kernel adds `@types/luxon` as a devDependency.** tsprov 0.5.1 declares `AttrValue` with `DateTime` of luxon; without the types the strict typed rules read the `error` type at `src/lineage.ts:111,353,354`. tsprov is the guessed long-term owner, but the types are needed now and a devDependency is the smallest correct step.

4. **Exact versions follow himmel, the reference repository:** `oxlint 1.85.0`, `oxlint-tsgolint 7.0.2003`, `@inflexa-ai/oxlint-plugin 0.7.0`, `@inflexa-ai/typecheck 0.7.0`. The plugin peers want `oxlint ^1.85.0` and `oxlint-tsgolint >=7.0.2003`, both met. `@inflexa-ai/typecheck` needs `@typescript/native: npm:typescript@7.0.2` in devDependencies (its README asks for the exact alias so npm dedupes the one TypeScript 7), and `typescript` stays the version 6 line that builds `dist/`, keeping the emitted bytes stable.

5. **`oxlint.config.ts` default-exports `typescript({ env: { node: true } })`** with the four rule settings of #606, in three override blocks (two settings share one block on the same glob): `typescript/no-unused-vars` with the four `^_` options (the preset sets the rule bare), `typescript/switch-exhaustiveness-check` with `considerDefaultExhaustiveForUnions: true` (not in the preset), `no-console` on `src/**`, and the js-recommended rule set on `scripts/**/*.mjs` (the preset applies `eslintRecommended` to TypeScript files only). The pinned 0.7.0 of the plugin exports no named `eslintRecommended` (its root exports are `typescript`, `plugin`, `restrictedSyntax`, `boundary`, `vitest`), so the mjs block carries a vendored copy of the preset's rule list, verified equal to the plugin's own preset rule for rule; a plugin bump must re-diff it, and the block swaps for the export when the lint repository ships one. The one sanctioned way to lift a syntax ban is the factory's own `syntax` option (for example `syntax: { regex: false }`), which the research proposes — never a fifth override block and never an inline directive. No `denyWarnings` override: the preset runs everything at `error`, and prov-kernel carries no warn-level rule.

6. **`bun run typecheck` runs `inflexa-typecheck` through its Node shebang.** Bun cannot host the command: its TypeScript 7 dependency reaches Node's `child_process` internals (`stdout._handle.fd`) that Bun's spawn lacks, and the command crashes under `bun --bun` (verified on the machine; himmel runs the bin under Node too). The command prints the diagnostics of `tsc --noEmit` on the same program first and the rule reports after, thus it replaces the `tsc` typecheck run, and a `typecheck.config.ts` override sets `must-use-result` to `['error', { consumers: ['unwrapOrThrow'] }]`, which replaces the patched ESLint wrapper: the same consumer list prov-kernel's wrapper knew, now typed and on the same program. The `tsc` build keeps TypeScript 6; the type check command runs TypeScript 7 through its own dependency.

7. **Each test moves to `src/test/`.** All eight `*.test.ts` files sit directly in `src/`, so the `test/` folder of their directory is one folder. `src/__fixtures__/` stays: `test-placement` matches test files, not fixtures. The build exclusion in `tsconfig.build.json` covers `src/test`, and the browser-safety guard keeps reading `dist/`.

8. **The lint fixes follow the rule intent, not directives.** prov-kernel has no inline directive today and gains none: `no-conditional-spread` sites build objects without conditional keys — for the document builders, tsprov skips `undefined` values and `golden.test.ts` proves the bytes; for the lineage read model, an optional member is assigned only when it holds a value, so a node keeps the same key set as before the change and `golden.test.ts` and the strict node assertions prove it. `require-assertion-safety` gets a `SAFETY:` comment per cast, and the attestation JWK fix is a real schema. `no-interface` turns `ProvSigner` and `ProvDocumentModelOptions` into type aliases — the `.d.ts` changes, which is the recorded API break. The `no-instanceof-error` lift for the error normalizer of `src/verify.ts` goes through the factory's own `instanceofErrorAllowIn` option with the reason in the config — the same class of factory-native lift as the `syntax` option, never an override block and never an inline disable. The one `no-unknown-type-guards` report at `src/lineage.ts:517` and the regex ban on `qnameSafe` are fixed in code (a typed parameter; a builtin or parser call) unless the evidence shows no replacement exists, in which case the syntax ban is lifted through the factory's `syntax` option with the reason recorded in the config — never by an inline disable.

9. **The attestation JWK gets a typed schema.** `publicKey` becomes a loose JWK object — `kty: z.literal("OKP")`, `crv: z.literal("Ed25519")`, `x: z.base64url()` (zod 4.4.3 exports it, and JWK key material is base64url), further members permitted per JWK — replacing `z.record(z.string(), z.unknown())`. Every real attestation carries an Ed25519 OKP JWK, so no existing artifact stops verifying, and the spec delta in this change states the surface.

10. **The Claude hook is one script under `.claude/hooks/`.** A `PostToolUse` hook on `Write|Edit|MultiEdit` reads the edited path, walks up to the nearest ancestor that holds an `oxlint.config.ts`, and runs `oxlint <file>` from that directory through bun; no config found means no output and exit 0. On a lint report it prints the report to stderr and exits 2, the convention of the neighboring hooks (`ste-check.ts` exits 2 on findings), so the agent sees the report. It uses the same shape as the existing hooks (`bun "${CLAUDE_PROJECT_DIR}/..."`), so it runs in every subsystem and stays inert in harness and cli until they gain their own configs in #609 and #610.

11. **CI keeps the job name and pins its Node.** `lint (prov-kernel)` keeps its name (`release-prov-kernel.yml:88` waits for it); the ESLint step becomes the oxlint step (`bun run lint`, whose script runs `bun --bun oxlint`, which the probe shows loads the TypeScript config under Bun), and the typecheck step runs the type check command under its Node shebang. Because that command needs Node 22.18 or later, the job adds `actions/setup-node` at a pinned version with Node 24 — the version comes from the workflow, not from the runner image.

## Risks / Trade-offs

- [The emitted `dist/` could drift] → `bun run build` before and after the tsconfig swap is compared on the file hashes; any difference stops the task.
- [The golden bytes could change through a `no-conditional-spread` fix] → `golden.test.ts` runs after each source fix; the fixture is never regenerated in this change.
- [TypeScript 7 (the type check command) reports diagnostics that TypeScript 6 misses] → the fix list of #605 task 6 grows; each fix is a real type correction, and a diagnostic that comes from a dependency declaration is fixed at the dependency side (the luxon types), not with a cast.
- [bun.lock must carry the platform binaries of oxlint and oxlint-tsgolint for CI] → `bun install --frozen-lockfile` in prov-kernel is the verification; the lock records the optional platform packages.
- [The hook slows each edit] → the hook lints one file with one config, oxlint runs in well under a second per the research, and the hook has a timeout like its neighbors.
- [The `.d.ts` API change breaks a consumer that declaration-merges into the two interfaces] → recorded as **BREAKING** in the proposal; cli pins the kernel version and moves with the next release.

## Migration Plan

The change lands as one branch. Rollback is reverting the branch: no data, no wire bytes, and no published artifact move with it. The version bump and the npm publish stay with the release workflow.
