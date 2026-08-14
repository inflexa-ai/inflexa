## RENAMED Requirements

- FROM: `### Requirement: Release binaries embed the skills and templates trees`
- TO: `### Requirement: Release binaries embed the skills, the templates, and the report page assets`

## MODIFIED Requirements

<!-- Each body below is the requirement as it stands, and the one change is the
     third tree. The rest is copied text, thus it keeps its original wording. -->

### Requirement: Release binaries embed the skills, the templates, and the report page assets

Every compiled release target SHALL embed the repository-root `skills/` and `templates/` trees plus the report page assets as a single content archive, and the build SHALL bake a deterministic **content hash** — computed over the archived file set (sorted `path` + `sha256(bytes)`), independent of tar mtime/ownership — into the binary as a compile-time constant. The archive and its hash SHALL be produced by `scripts/build.ts` for every cross-compiled target, and the build's existing `--version` smoke test SHALL still pass.

The asset entries MUST come from the manifest that the harness exports, and the build MUST restate no file name of its own. Each entry names a staged file and a module specifier. The build MUST resolve each specifier through the installation of the harness. The packages that hold the assets are dependencies of the harness, and not of the CLI.

The build MUST refuse a specifier that does not resolve, thus a binary that misses a manifest entry never ships. The build MUST also refuse an empty manifest. An empty manifest writes no assets directory, and the boot then re-extracts on each run with nothing to say so.

#### Scenario: Build embeds content into each target

- **WHEN** `bun run build` (or `build:all`) compiles a target
- **THEN** the resulting binary carries the skills+templates+assets archive internally and a baked content hash identifying that exact file set, with no separate content artifact emitted

#### Scenario: Identical content yields the same hash

- **WHEN** two builds embed byte-identical skills+templates+assets trees
- **THEN** both bake the same content hash, and a changed file in any tree produces a different hash

#### Scenario: An unresolvable asset refuses the build

- **WHEN** a manifest specifier resolves to no file at build time
- **THEN** the build stops with a message that names that specifier, and it emits no binary

#### Scenario: An empty manifest refuses the build

- **WHEN** the manifest carries no entry at build time
- **THEN** the build stops, because a binary with no assets directory re-extracts on each run

#### Scenario: The manifest is the one source of the asset set

- **WHEN** a harness version adds an entry to the manifest
- **THEN** the next build packs that entry with no edit to the build script

### Requirement: First run materializes bundled content under the data directory

On a release-build boot, before the skills/templates pre-flight existence gate, the system SHALL ensure the embedded archive is extracted to `join(env.contentDir, <contentHash>, {"skills","templates","assets"})` — where `env.contentDir` is `join(dataDir(), "inflexa", "content")`, a peer of `refs/` and `models/` — and SHALL resolve `skillsDir`/`templatesDir` to that directory when no config override is set. Extraction SHALL be atomic (extract into a temporary sibling directory, then `rename` onto the hash-named directory) and idempotent (an already-present hash directory is reused without re-extracting).

The materialization MUST give back the assets directory beside the other two. The warm-path check MUST cover each of the three, thus a hash directory that holds two of them is not reused as complete.

#### Scenario: Fresh install extracts and boots

- **WHEN** a freshly installed binary boots with an empty data directory and no `skillsDir`/`templatesDir` override
- **THEN** the embedded archive is extracted to `contentDir/<hash>/{skills,templates,assets}`, the pre-flight gate passes, and the harness reads skills and renders templates from that directory

#### Scenario: Already-extracted content is reused

- **WHEN** the hash directory already exists from a prior run
- **THEN** boot resolves to it without re-extracting

#### Scenario: A partial extract is never resolved to

- **WHEN** extraction is interrupted before completion
- **THEN** no partially-written tree is visible under the final hash name (the atomic `rename` never happened), and the next boot re-extracts cleanly
