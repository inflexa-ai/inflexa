# cli-reference-docs delta — hardening

## MODIFIED Requirements

### Requirement: Reference docs are generated from commander introspection

The system SHALL provide a generator script at `scripts/gen_docs.ts`, run as a plain `bun scripts/gen_docs.ts` process (exposed as the `docs:gen` package script), that imports the configured `cli` Command from `src/cli/index.ts` (never `src/index.ts`) and EVERY exported environment-variable doc list from `src/lib/env.ts` (`envDoc`, `modelConnectionEnvDoc`, `embeddingEnvDoc`), recursively walks `.commands`/`.options`/`.registeredArguments`, and emits every documentation output from that single walk without invoking any command action. The generator SHALL add no dependency to `package.json`. A doc list declared in `src/lib/env.ts` that reaches no rendered page SHALL be a test failure — an environment variable that is a feature's only channel must not be invisible in the published reference.

#### Scenario: Generation walks the full visible tree

- **WHEN** `bun run docs:gen` runs
- **THEN** every visible command and command group in the registry produces a markdown page containing its usage line, description, argument table, and option table (flags, description, default value where declared)
- **AND** no command action module (TUI, db, harness) is imported by the generator process

#### Scenario: Environment page renders from envDoc

- **WHEN** generation runs
- **THEN** an `environment.md` page is emitted with the Paths and Environment tables rendered from `envDoc` entries, not scraped from `--help` text
- **AND** the page also renders the model-connection and embedding variable lists, so `INFLEXA_MODEL_API_KEY` and `INFLEXA_EMBEDDING_API_KEY` each appear with their descriptions

#### Scenario: An unrendered doc list fails the suite

- **WHEN** a new exported env-var doc list is added to `src/lib/env.ts` without a render site in the generator
- **THEN** a test fails naming the list, rather than the variables silently missing from the published package
