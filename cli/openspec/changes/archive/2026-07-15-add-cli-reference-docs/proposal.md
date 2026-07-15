# Add CLI Reference Docs Generation and Publishing

## Why

The CLI has a rich, nested command surface (six command groups, options with defaults, negated `--no-*` flags, variadic positionals, an env/paths help appendix) but its only documentation is the runtime `--help`. The public website (atrium, a separate repo) needs a CLI reference it can render. Commander v15 exposes the full command tree programmatically (`.commands`/`.options`/`.registeredArguments`) and the registry is already importable without side effects — the docs can be generated from the single source of truth instead of hand-written and drifting.

## What Changes

- New Bun script `scripts/gen_docs.ts` (zero new dependencies) that imports the configured `cli` Command from `src/cli/index.ts` and `envDoc` from `src/lib/env.ts`, walks the command tree, and emits the **publishable docs package** into an untracked build directory: portable CommonMark pages (one per command/group, frontmatter limited to `title` + `description`) plus `manifest.json` (`cliVersion`, `schemaVersion`, ordered nav tree) — the SSG-neutral contract the website consumes. Nothing generated is committed to git.
- Portability rules for all emitted markdown: CommonMark-only (no admonitions/Vue/MDX syntax); every machine-emitted flag/usage/argument token wrapped in code spans, because raw angle brackets (`--analysis <id|name>`) are parsed as HTML by VitePress and Python-Markdown.
- Dev-channel commands (`profile`/`run`/`chat`) are excluded: generation runs with the dev channel off, so the docs describe exactly the release binary's surface.
- All positional arguments in the registry gain descriptions: inline declarations (`cli.command("new [name] [paths...]")`) convert to `.argument("<name>", "description")` calls. User-visible command syntax is unchanged; `--help` and generated docs gain argument tables.
- `package.json` gains a `docs:gen` script; CI runs the generator on every PR so a registry change that breaks generation (missing description, import failure) fails in CI, not first at release time.
- The repo-level release workflow (`.github/workflows/release.yml`) gains a step that tars the docs package as `cli-docs.tar.gz` and attaches it to the GitHub release it already creates. The repo is public, so consumers fetch `releases/latest/download/cli-docs.tar.gz` unauthenticated.
- **Recorded caveat**: `src/lib/env.ts` has a data-loss guard that throws when `NODE_ENV=test` without `INFLEXA_TEST_SANDBOX`. The generator imports it transitively, so it MUST run as a plain `bun scripts/gen_docs.ts` — never under `bun test`.

Out of scope: the website-side consumption (VitePress glue lives in the atrium repo; VitePress 1.x is the recommended consumer, but the published contract is SSG-neutral).

## Capabilities

### New Capabilities

- `cli-reference-docs`: Generating the CLI reference from commander introspection — the generator's inputs (command tree, `envDoc`), its output (publishable package with manifest), the markdown portability contract, the manifest schema, dev-channel exclusion, the argument-description requirement on the registry, the CI generation check, and the release-asset packaging.

### Modified Capabilities

<!-- None: converting inline positionals to .argument() calls preserves the exact
     user-visible syntax that cli-core/projects/prov-*/auth-commands pin ("SHALL
     register `inflexa new [name] [paths...]`"), and dev-commands' registration
     gating is consumed as-is, not changed. -->

## Impact

- **Affected code**: `cli/scripts/gen_docs.ts` (new), `cli/src/cli/index.ts` (argument declarations converted to `.argument()`; no behavior change), `cli/package.json` (`docs:gen` script), `.github/workflows/release.yml` (asset step) and the CI lint workflow (generation check).
- **Dependencies**: none added — the generator uses commander's public introspection API and Bun's stdlib.
- **Consumers**: the atrium website fetches the release asset; `manifest.json`'s `schemaVersion` is the compatibility handle for that contract.
- **Release pipeline**: one additive upload step; the attested release flow is otherwise untouched.
