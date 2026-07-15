# cli-reference-docs Specification

## Purpose
The generated CLI reference: a Bun introspection script (`scripts/gen_docs.ts`) that walks the commander registry and `envDoc`, and emits the SSG-neutral publishable docs package — CommonMark pages plus `manifest.json` — shipped as a `cli-docs.tar.gz` release asset for the website to consume.
## Requirements
### Requirement: Reference docs are generated from commander introspection

The system SHALL provide a generator script at `scripts/gen_docs.ts`, run as a plain `bun scripts/gen_docs.ts` process (exposed as the `docs:gen` package script), that imports the configured `cli` Command from `src/cli/index.ts` (never `src/index.ts`) and `envDoc` from `src/lib/env.ts`, recursively walks `.commands`/`.options`/`.registeredArguments`, and emits every documentation output from that single walk without invoking any command action. The generator SHALL add no dependency to `package.json`.

#### Scenario: Generation walks the full visible tree

- **WHEN** `bun run docs:gen` runs
- **THEN** every visible command and command group in the registry produces a markdown page containing its usage line, description, argument table, and option table (flags, description, default value where declared)
- **AND** no command action module (TUI, db, harness) is imported by the generator process

#### Scenario: Environment page renders from envDoc

- **WHEN** generation runs
- **THEN** an `environment.md` page is emitted with the Paths and Environment tables rendered from `envDoc` entries, not scraped from `--help` text

### Requirement: Generator never runs under bun test

Because `src/lib/env.ts` throws at module evaluation when `NODE_ENV=test` without `INFLEXA_TEST_SANDBOX` (data-loss guard), the generator SHALL refuse to run inside a test process: it exits non-zero with an explanatory message when `NODE_ENV` is `test`, and no test file may import `scripts/gen_docs.ts`. CI checks that need generation SHALL invoke the script as a subprocess.

#### Scenario: Test-process invocation is refused

- **WHEN** the generator is executed in a process where `NODE_ENV` is `test`
- **THEN** it exits non-zero before importing the registry, naming the plain `bun scripts/gen_docs.ts` invocation as the supported path

### Requirement: Docs describe exactly the release command surface

Generation SHALL run with the dev channel off: the generator bakes the production build channel into its process environment (`INFLEXA_BUILD_CHANNEL=production`) and removes `INFLEXA_DEV` before importing the registry — dev commands register for any non-production channel, including the unset channel of a plain source run — so dev-channel commands (`profile`, `run`, `chat`) are absent from every output by the same registration gate that shapes a release binary. No output may contain a dev-channel command page or nav entry.

#### Scenario: Dev-channel commands are absent

- **WHEN** generation runs in a shell that has `INFLEXA_DEV=1` exported
- **THEN** the emitted pages and `manifest.json` nav contain no `profile`, `run`, or `chat` entries

### Requirement: Emitted markdown is SSG-neutral CommonMark

All emitted pages SHALL be CommonMark-only with frontmatter limited to `title` and `description`. The generator SHALL wrap every machine-emitted flag, usage line, and argument token in code spans or fenced blocks (raw angle brackets such as `--analysis <id|name>` are parsed as HTML by VitePress and Python-Markdown), SHALL emit no admonitions, MDX/JSX, template interpolation syntax, or raw HTML blocks, and SHALL escape `<` and `{{` occurring in description prose. Output SHALL be byte-deterministic: no timestamps or environment-dependent content.

#### Scenario: Angle-bracket tokens are code-spanned

- **WHEN** a command declares an option `--analysis <id|name>`
- **THEN** every occurrence of that flag in the emitted markdown appears inside a code span or fenced block

#### Scenario: Regeneration without registry changes is byte-identical

- **WHEN** generation runs twice against an unchanged registry
- **THEN** all emitted files are byte-identical across the two runs

### Requirement: Generation emits the publishable package only

Generation SHALL emit exactly one output: the publishable package in an untracked build directory (`dist-docs/`), containing the markdown pages plus `manifest.json`. The package SHALL mirror the command tree as directories (one directory per command group with an `index.md`, e.g. `prov/export.md`). No generated documentation SHALL be committed to git; the build directory SHALL be git-ignored.

#### Scenario: Output is untracked

- **WHEN** generation completes
- **THEN** all emitted files live under the git-ignored build directory and `git status` reports no new tracked-path changes from generation

### Requirement: Manifest carries version and nav structure

The package's `manifest.json` SHALL carry `schemaVersion` (integer, bumped only on breaking manifest changes), `cliVersion` (the `package.json` version the docs were generated from), `name` (the CLI name), and `nav` — an ordered tree of `{ title, path, items? }` entries covering every emitted page exactly once, in registry declaration order (no alphabetical resorting). Consumers resolve `path` relative to the package root.

#### Scenario: Nav covers all pages in declaration order

- **WHEN** the package is generated
- **THEN** every emitted `.md` file appears exactly once in `nav`, nested to match the command tree, ordered as the registry declares the commands

#### Scenario: Version fields identify the artifact

- **WHEN** a consumer reads `manifest.json`
- **THEN** `cliVersion` equals the generating `package.json` version and `schemaVersion` identifies the manifest contract revision

### Requirement: All visible arguments and options carry descriptions

Every visible positional argument in the registry SHALL be declared via `.argument(name, description)` with a non-empty description (inline positional syntax in the command string is not used), and every visible option SHALL have a non-empty description. The generator SHALL exit non-zero naming the offending command when a visible argument or option has an empty description. User-visible command syntax is unchanged by the declaration style.

#### Scenario: Missing description fails generation

- **WHEN** a visible command argument is registered without a description
- **THEN** `bun run docs:gen` exits non-zero and names the command and argument

#### Scenario: Argument descriptions surface in help and docs

- **WHEN** `inflexa new --help` is shown or docs are generated
- **THEN** the `[name]` and `[paths...]` positionals appear with their descriptions

### Requirement: CI verifies generation succeeds

Repository CI SHALL run the generator (as a subprocess, per the bun-test constraint) on every pull request and fail when it exits non-zero — covering an argument or option registered without a description, a registry that stops being importable standalone, and any violation of the generator's own output assertions.

#### Scenario: Registry change that breaks generation fails CI

- **WHEN** a pull request registers a visible argument without a description
- **THEN** the CI generation check fails, naming the offending command and argument

### Requirement: Docs package ships as a release asset

The repo-level release workflow SHALL generate the publishable package at the release's source revision, tar it as `cli-docs.tar.gz` (manifest and pages at the archive root), and attach it to the GitHub release it creates for the version, so consumers can fetch `releases/latest/download/cli-docs.tar.gz` or the version-pinned URL unauthenticated.

#### Scenario: Release carries the docs asset

- **WHEN** a release for version `X` is published
- **THEN** the release has a `cli-docs.tar.gz` asset whose `manifest.json` reports `cliVersion` = `X`
