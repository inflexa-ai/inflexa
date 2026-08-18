# content-assets Specification

## Purpose
TBD - created by archiving change add-bundled-content-assets. Update Purpose after archive.
## Requirements
### Requirement: Release binaries embed the skills and the report page assets

Every compiled release target SHALL embed the repository-root `skills/` tree plus the report page assets as a single content archive, and the build SHALL bake a deterministic **content hash** — computed over the archived file set (sorted `path` + `sha256(bytes)`), independent of tar mtime/ownership — into the binary as a compile-time constant. The archive and its hash SHALL be produced by `scripts/build.ts` for every cross-compiled target, and the build's existing `--version` smoke test SHALL still pass.

The asset entries MUST come from the manifest that the harness exports, and the build MUST restate no file name of its own. Each entry names a staged file and a module specifier. The build MUST resolve each specifier through the installation of the harness. The packages that hold the assets are dependencies of the harness, and not of the CLI.

The build MUST refuse a specifier that does not resolve, thus a binary that misses a manifest entry never ships. The build MUST also refuse an empty manifest. An empty manifest writes no assets directory, and the boot then re-extracts on each run with nothing to say so.

#### Scenario: Build embeds content into each target

- **WHEN** `bun run build` (or `build:all`) compiles a target
- **THEN** the resulting binary carries the skills+assets archive internally and a baked content hash identifying that exact file set, with no separate content artifact emitted

#### Scenario: Identical content yields the same hash

- **WHEN** two builds embed byte-identical skills+assets trees
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

On a release-build boot, before the skills pre-flight existence gate, the system SHALL ensure the embedded archive is extracted to `join(env.contentDir, <contentHash>, {"skills","assets"})` — where `env.contentDir` is `join(dataDir(), "inflexa", "content")`, a peer of `refs/` and `models/` — and SHALL resolve `skillsDir` to that directory when no config override is set. Extraction SHALL be atomic (extract into a temporary sibling directory, then `rename` onto the hash-named directory) and idempotent (an already-present hash directory is reused without re-extracting).

The materialization MUST give back the assets directory beside the skills tree. The warm-path check MUST cover each of the two, thus a hash directory that holds one of them is not reused as complete.

#### Scenario: Fresh install extracts and boots

- **WHEN** a freshly installed binary boots with an empty data directory and no `skillsDir` override
- **THEN** the embedded archive is extracted to `contentDir/<hash>/{skills,assets}`, the pre-flight gate passes, and the harness reads the skills from that directory

#### Scenario: Already-extracted content is reused

- **WHEN** the hash directory already exists from a prior run
- **THEN** boot resolves to it without re-extracting

#### Scenario: A partial extract is never resolved to

- **WHEN** extraction is interrupted before completion
- **THEN** no partially-written tree is visible under the final hash name (the atomic `rename` never happened), and the next boot re-extracts cleanly

### Requirement: A new binary version updates the on-disk content automatically

Because the extraction directory is keyed by content hash, installing a binary whose embedded content differs SHALL cause its first run to extract a fresh tree under the new hash and resolve to it, with no separate download or update step; a binary whose content is byte-identical to a prior one SHALL reuse the existing directory. Stale hash directories (basename neither the current hash nor a live temporary) SHALL be pruned best-effort, and pruning failures SHALL NOT block boot.

#### Scenario: Upgrade re-extracts fresh content

- **WHEN** a newer binary carrying changed skills first runs against a data dir that holds an older hash directory
- **THEN** it extracts and resolves to a new `contentDir/<newhash>` tree, and the harness reads the new content

#### Scenario: Content-neutral upgrade reuses the tree

- **WHEN** a new binary version embeds content byte-identical to the installed one
- **THEN** its content hash matches and boot reuses the existing directory without re-extracting

#### Scenario: Stale directories are pruned without blocking boot

- **WHEN** old hash directories remain after an upgrade and pruning a directory fails
- **THEN** boot still succeeds and the failure is non-fatal

### Requirement: Development runs resolve to the repository content trees

A development build SHALL NOT embed or extract content: it SHALL resolve `skillsDir` to the repository-root `skills/` tree via `import.meta.dir`, and the `INFLEXA_DEV=1` support escape hatch SHALL NOT repoint content resolution — content resolution keys off the build channel, not the dev-commands toggle.

#### Scenario: Dev uses the checkout, never the data dir

- **WHEN** `bun run dev` resolves the skills
- **THEN** it points at the repo-root tree and never reads or writes `env.contentDir`

#### Scenario: Dev-commands hatch does not repoint content

- **WHEN** a shipped binary runs with `INFLEXA_DEV=1`
- **THEN** content still resolves to the extracted data-dir tree, not a repo checkout

### Requirement: Content materialization failure fails boot visibly

When the embedded archive cannot be materialized — an unwritable data directory, an unreadable archive, or an extraction failure — the system SHALL fail boot with an error that names the target path and the remedy, and SHALL NOT fall back to a fake or empty content directory. Materialization SHALL be expressed on the `Result` channel (no `throw`), and its error SHALL be distinguishable from the plain `skills_dir_missing` gate.

#### Scenario: Unwritable data directory reports the real cause

- **WHEN** extraction cannot write under `env.contentDir`
- **THEN** boot fails naming the path and remedy, rather than surfacing the misleading downstream "skills directory not found" gate error

