# Proposal

## Why

Issue #610 (order issue: #608) moves the lint of `cli/` from ESLint to oxlint. The harness and prov-kernel already run oxlint and the type check command of `inflexa-ai/lint`; cli is the last ESLint holdout, and the ESLint stack carries a patched plugin and a wrapper whose maintenance cost the shared packages removed. The full Inflexa preset reports thousands of sites on cli (#608 holds the measured counts), so this change moves the tools only: each preset rule that has reports stays off, and the child issues of #608 turn each one back on with its fixes.

## What Changes

- Replace the ESLint stack (`eslint`, `@eslint/js`, `typescript-eslint`, `globals`, `eslint-plugin-solid`, `eslint-plugin-neverthrow`, its bun patch, `eslint.config.js`) with `oxlint` 1.85.0, `oxlint-tsgolint` 7.0.2003, `@inflexa-ai/oxlint-plugin` 0.8.0, `@inflexa-ai/oxlint-plugin-solid` 0.8.0, `@inflexa-ai/typecheck` 0.8.0, and the alias `@typescript/native` = `npm:typescript@7.0.2`, pinned exact. `typescript` stays `^6.0.3`. This is the dependency shape of `harness/package.json`.
- Add `oxlint.config.ts` on the shape of `harness/oxlint.config.ts`: `solid({ env: { browser: true } })`, every ban of `eslint.config.js` carried over (NODE_ENV, `.action(` in the registry, `process.env` reads, the `dev/` import boundary, the client import boundary — as `eslint-js/no-restricted-syntax` source selectors, because the native rule of oxlint 1.85.0 silently never matches a lookahead regex — `no-unused-vars` options, `switch-exhaustiveness-check`), plus the two opentui renderer bans (no hex color literal, no inlined glyph literal in the TUI) as entries of `eslint-js/no-restricted-syntax`.
- Add `typecheck.config.ts` on the shape of `harness/typecheck.config.ts`: `must-use-result` on for `src/**` with the consumers that cli names, off for the test globs pending #810. `bun run typecheck` runs `inflexa-typecheck`; `bun run lint` runs `bun --bun oxlint`.
- Turn off each preset rule that has reports, each `off` entry commented with the child issue of #608 that turns it back on (#804 through #811), except the bun-types false reports in tests (`typescript/await-thenable`, `typescript/no-confusing-void-expression`), which stay off for good. A rule that the ESLint config already ran stays on: oxlint's new reports of such a rule are fixed at the site, with no behavior change and no weaker test.
- Rewrite each inline `eslint-disable` directive with its new spelling; the two yielded Results in `src/client/api.ts` take `typecheck-disable-next-line must-use-result`; the two lazy `dev/` imports in `src/cli/index.ts` take inline `no-restricted-imports` exemptions, because oxlint reports a dynamic `import()` where ESLint did not.
- Port the two tests that drive the ESLint API (`src/client/import_boundary.test.ts`, `src/cli/agent_policy_tree.test.ts`) to drive the oxlint binary against the real config, keeping the same banned, allowed, and exempt cases.
- Update `.github/workflows/lint.yml`: the cli job keeps its `lint (cli)` name, gains `setup-node` for the type check command, and its ESLint wording changes. Update the text that names ESLint in `cli/CLAUDE.md`, `cli/README.md`, four specs, two source comments, and the `db-ops` skill.

## Capabilities

### New Capabilities
- `syntax-bans`: the opentui renderer bans — no hex color literal and no inlined glyph literal in the TUI source — stay on as entries of `eslint-js/no-restricted-syntax` and report nothing.

### Modified Capabilities
- `result-types`: the `must-use-result` requirement moves from `eslint-plugin-neverthrow` in `eslint.config.js` to the `must-use-result` rule of the type check command in `typecheck.config.ts`; the rule is off in the test globs pending #810.
- `agent-command-policy`: the static-enforcement requirement names the oxlint restricted-syntax entries instead of an ESLint restriction.
- `dev-commands`: the build-mode requirement names a lint rule instead of an ESLint rule; the dev-only requirement bans the dynamic `import()` form too, and the registration gate's lazy imports carry inline directives.
- `tui-text-emphasis`: the scoped disable is an `oxlint-disable`, and the theme/glyph resolution sentence carries the two new lint bans.

## Impact

- `cli/package.json` (scripts, devDependencies, `patchedDependencies`), `cli/bun.lock`, deleted `cli/eslint.config.js` and `cli/patches/eslint-plugin-neverthrow@1.1.4.patch`, new `cli/oxlint.config.ts` and `cli/typecheck.config.ts`.
- Product code: inline directives across `src/` and `scripts/`; `src/client/api.ts` (directives), `src/cli/index.ts` (directives), `src/modules/sbom/sbom.ts` and `src/server/routes/store.ts` (consumers entries, no behavior change), the two ported tests; the sites of the rules that stay on (see What Changes), fixed with no behavior change; the comments that name ESLint (`src/cli/agent_policy.ts`, `src/lib/credential.test.ts`).
- CI: `.github/workflows/lint.yml` (cli job steps and wording) and `.github/workflows/release.yml` (the job that runs the cli typecheck gains `setup-node` for the Node-shebang type check command); the check name `lint (cli)` stays, so no gate changes.
- Documents: `cli/CLAUDE.md`, `cli/README.md`, `cli/openspec/specs/{result-types,agent-command-policy,dev-commands,tui-text-emphasis}/spec.md`, `.claude/skills/db-ops/SKILL.md` (it names the ESLint rule). The archived changes stay as written: an archive records history.
- Out of scope: turning any preset rule with reports back on (the child issues of #608), the formatter (prettier stays), and any behavior change in product code.
