# Proposal

## Why

The typed lint rules do not see the test code: the build `tsconfig.json` of harness and prov-kernel excludes the tests, and oxlint with its typed rules and the type check command both read the nearest `tsconfig.json`, so they type the test files with the `error` type and report false positives (1165 on prov-kernel today, 205 after this change); the lint program of harness also resolves no `bun:test` types. Issue #605 fixes the program; issue #606 then moves the lint of prov-kernel, the smallest subsystem, from ESLint to oxlint with the full shared preset of `@inflexa-ai/oxlint-plugin`, as the first step of the removal epic #611.

## What Changes

- Each subsystem `tsconfig.json` becomes the lint and typecheck program: it includes all of `src` with `"types": ["bun", "node"]` (harness and prov-kernel) and the tests stay in the program (#605).
- The build options move to a new `tsconfig.build.json` in harness and prov-kernel, which excludes the tests. The scripts `build`, `prepare` and `typecheck` change, and `prepare` keeps emitting (#605).
- `tsconfig.eslint.json` is deleted in harness and prov-kernel; each reference changes: `package.json` scripts, `eslint.config.js` of harness, `.github/workflows/lint.yml`, `harness/src/report-render/fixture.ts`, `harness/src/tools/define-tool.test.ts`, each `CLAUDE.md` (#605).
- `cli/tsconfig.json` adds `"DOM"` to `lib`, so `solid-js` types `JSX.Element` with a resolvable `Node` (#605).
- prov-kernel adds the luxon types, which `@inflexa-ai/tsprov` 0.5.1 references in its declarations (#605).
- Each type error that the test-inclusive program shows is fixed (#605).
- prov-kernel installs `oxlint`, `oxlint-tsgolint`, `@inflexa-ai/oxlint-plugin` and `@inflexa-ai/typecheck` at exact versions, and removes `eslint`, `@eslint/js`, `typescript-eslint`, `globals`, `eslint-plugin-neverthrow` and the bun patch (#606).
- prov-kernel gets `oxlint.config.ts`, default-exporting `typescript({ env: { node: true } })` with the named overrides, and `typecheck.config.ts`; `bun run lint` runs oxlint, `bun run typecheck` runs `inflexa-typecheck` with the `consumers` option `unwrapOrThrow` (#606).
- `eslint.config.js` of prov-kernel is deleted (#606).
- Each prov-kernel test moves into the `test/` folder of its directory (#606).
- Each report of the full preset is fixed; the public API changes where the fixes ask for it: `ProvSigner` and `ProvDocumentModelOptions` become type aliases, and the attestation schema types the public JWK (#606, **BREAKING** for the `.d.ts` surface and the accepted JWK shape).
- A Claude hook in `.claude/settings.json` of the root runs oxlint on each edited `.ts`/`.tsx` file with the `oxlint.config.ts` of its subsystem, and does nothing where none exists (#606).
- `.github/workflows/lint.yml` runs the new lint of prov-kernel; the job name `lint (prov-kernel)` stays, because `release-prov-kernel.yml` waits for it. Each text that names ESLint in `prov-kernel/CLAUDE.md`, `package.json` and `lint.yml` changes (#606).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `prov-kernel`: the export attestation schema types the public JWK as an Ed25519 OKP JWK instead of an untyped record, so the attestation validation surface changes; the rest of the change (tsconfig layout, lint tooling, test placement, CI, hooks) changes no requirement.

## Impact

- `prov-kernel/`: `tsconfig.json`, new `tsconfig.build.json`, `package.json`, `bun.lock`, new `oxlint.config.ts` and `typecheck.config.ts`, deleted `eslint.config.js` and `tsconfig.eslint.json` and `patches/eslint-plugin-neverthrow@1.1.4.patch`, `CLAUDE.md`, `src/` type fixes (about 205 lint reports per `tmp/claude/lint/prov-kernel.md` section 3), tests moved to `src/test/`. `SPEC.md` needs no edit: it already states the JWK shape (`kty` `OKP`, `crv` `Ed25519`, base64url key material) at its lines 510 and 533, and the typed schema aligns the code with that text.
- `harness/`: `tsconfig.json`, new `tsconfig.build.json`, deleted `tsconfig.eslint.json`, `package.json` scripts, `eslint.config.js` project reference, `CLAUDE.md` (the lines that name `tsconfig.eslint.json` and the build command `tsc -p tsconfig.json`, which the swap moves to `tsconfig.build.json`), comment fixes in `src/report-render/fixture.ts` and `src/tools/define-tool.test.ts`.
- `cli/`: `tsconfig.json` `lib`, `CLAUDE.md` only where it names the typecheck program, and the small DOM-lib fallout the acceptance of #605 task 4 asks for: `src/lib/download.ts` (a double cast with its reason comment), `src/tui/layout/activity_panel.tsx`, and the `Uint8Array<ArrayBuffer>` annotations that the DOM lib types surface in two test files.
- Root: `.claude/settings.json` hook, `.github/workflows/lint.yml`.
- Published surface: the `.d.ts` of `@inflexa-ai/prov-kernel` changes — `ProvSigner` and `ProvDocumentModelOptions` become type aliases, the attestation `publicKey` becomes the typed JWK, `buildDocumentModel` gains its explicit return type, and `ProvDocumentModelInternal` becomes a hand-written member list in place of the inferred `ReturnType` — which asks for a version bump at release time; the golden fixture must not change, and the lineage read model keeps its key set: an optional member is absent, never present with `undefined`.
