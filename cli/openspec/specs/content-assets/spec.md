# content-assets Specification

## Purpose
TBD - created by archiving change add-bundled-content-assets. Update Purpose after archive.
## Requirements
### Requirement: Release binaries embed the skills and templates trees

Every compiled release target SHALL embed the repository-root `skills/` and `templates/` trees as a single content archive, and the build SHALL bake a deterministic **content hash** — computed over the archived file set (sorted `path` + `sha256(bytes)`), independent of tar mtime/ownership — into the binary as a compile-time constant. The archive and its hash SHALL be produced by `scripts/build.ts` for every cross-compiled target, and the build's existing `--version` smoke test SHALL still pass.

#### Scenario: Build embeds content into each target

- **WHEN** `bun run build` (or `build:all`) compiles a target
- **THEN** the resulting binary carries the skills+templates archive internally and a baked content hash identifying that exact file set, with no separate content artifact emitted

#### Scenario: Identical content yields the same hash

- **WHEN** two builds embed byte-identical skills+templates trees
- **THEN** both bake the same content hash, and a changed file in either tree produces a different hash

### Requirement: First run materializes bundled content under the data directory

On a release-build boot, before the skills/templates pre-flight existence gate, the system SHALL ensure the embedded archive is extracted to `join(env.contentDir, <contentHash>, {"skills","templates"})` — where `env.contentDir` is `join(dataDir(), "inflexa", "content")`, a peer of `refs/` and `models/` — and SHALL resolve `skillsDir`/`templatesDir` to that directory when no config override is set. Extraction SHALL be atomic (extract into a temporary sibling directory, then `rename` onto the hash-named directory) and idempotent (an already-present hash directory is reused without re-extracting).

#### Scenario: Fresh install extracts and boots

- **WHEN** a freshly installed binary boots with an empty data directory and no `skillsDir`/`templatesDir` override
- **THEN** the embedded archive is extracted to `contentDir/<hash>/{skills,templates}`, the pre-flight gate passes, and the harness reads skills and renders templates from that directory

#### Scenario: Already-extracted content is reused

- **WHEN** the hash directory already exists from a prior run
- **THEN** boot resolves to it without re-extracting

#### Scenario: A partial extract is never resolved to

- **WHEN** extraction is interrupted before completion
- **THEN** no partially-written tree is visible under the final hash name (the atomic `rename` never happened), and the next boot re-extracts cleanly

### Requirement: A new binary version updates the on-disk content automatically

Because the extraction directory is keyed by content hash, installing a binary whose embedded content differs SHALL cause its first run to extract a fresh tree under the new hash and resolve to it, with no separate download or update step; a binary whose content is byte-identical to a prior one SHALL reuse the existing directory. Stale hash directories (basename neither the current hash nor a live temporary) SHALL be pruned best-effort, and pruning failures SHALL NOT block boot.

#### Scenario: Upgrade re-extracts fresh content

- **WHEN** a newer binary carrying changed skills/templates first runs against a data dir that holds an older hash directory
- **THEN** it extracts and resolves to a new `contentDir/<newhash>` tree, and the harness reads the new content

#### Scenario: Content-neutral upgrade reuses the tree

- **WHEN** a new binary version embeds content byte-identical to the installed one
- **THEN** its content hash matches and boot reuses the existing directory without re-extracting

#### Scenario: Stale directories are pruned without blocking boot

- **WHEN** old hash directories remain after an upgrade and pruning a directory fails
- **THEN** boot still succeeds and the failure is non-fatal

### Requirement: Development runs resolve to the repository content trees

A development build SHALL NOT embed or extract content: it SHALL resolve `skillsDir`/`templatesDir` to the repository-root `skills/`/`templates/` trees via `import.meta.dir`, and the `INFLEXA_DEV=1` support escape hatch SHALL NOT repoint content resolution — content resolution keys off the build channel, not the dev-commands toggle.

#### Scenario: Dev uses the checkout, never the data dir

- **WHEN** `bun run dev` resolves skills/templates
- **THEN** it points at the repo-root trees and never reads or writes `env.contentDir`

#### Scenario: Dev-commands hatch does not repoint content

- **WHEN** a shipped binary runs with `INFLEXA_DEV=1`
- **THEN** content still resolves to the extracted data-dir tree, not a repo checkout

### Requirement: Content materialization failure fails boot visibly

When the embedded archive cannot be materialized — an unwritable data directory, an unreadable archive, or an extraction failure — the system SHALL fail boot with an error that names the target path and the remedy, and SHALL NOT fall back to a fake or empty content directory. Materialization SHALL be expressed on the `Result` channel (no `throw`), and its error SHALL be distinguishable from the plain `skills_dir_missing`/`templates_dir_missing` gate.

#### Scenario: Unwritable data directory reports the real cause

- **WHEN** extraction cannot write under `env.contentDir`
- **THEN** boot fails naming the path and remedy, rather than surfacing the misleading downstream "skills directory not found" gate error

