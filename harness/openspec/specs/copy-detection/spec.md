# copy-detection Specification

## Purpose

Gives the duplicate-code gate of the harness: a pinned copy detector scans the
source and the scripts of the harness, so a pull request that adds a copy above
the committed floor fails the lint job, and a copy that stays duplicated carries
its reason at the ignore site.

## Requirements

### Requirement: The harness pins the copy detector and commits its configuration

The harness MUST declare `jscpd` as a dev dependency at one exact version. The
harness MUST commit a `.jscpd.json` at its root that names, for the code formats
of the `src` and `scripts` trees — TypeScript, TSX, JavaScript, Python, R, and
bash — the minimum size of a reported copy in tokens and in lines. The
configuration MUST carry the reason for that floor, the reason for each ignored
tree, and the reason for the data formats that stay outside the scan, inside the
configuration file. The configuration MUST exclude `dist`, `node_modules`, and
the generated gallery data directories from the scan, and MUST NOT exclude any
tree that holds hand-written code of the harness.

#### Scenario: The configuration names the floor and its reasons

- **WHEN** `harness/.jscpd.json` is read
- **THEN** it holds a minimum token count and a minimum line count for a
  reported copy, and the reason for the floor, for each ignored tree, and for
  the data formats left out sits in the same file

#### Scenario: Data formats stay outside the gate

- **WHEN** the scan runs over `src` and `scripts`
- **THEN** it analyzes no JSON, YAML, or plain-text file, because a fixture
  repeats data and not code, and it still analyzes each R and bash file of the
  trees, because those files are code

### Requirement: The dupes script fails when the scan reports a copy

The harness script `bun run dupes` MUST run the detector over the `src` and
`scripts` trees and exit with status 0 only when the scan reports no copy at or
above the floor. It MUST exit with a non-zero status when the scan reports such
a copy. It MUST exit with a non-zero status when the scan analyzes no file, so a
configuration drift that matches nothing cannot pass as a clean run.

#### Scenario: A clean tree passes

- **WHEN** `bun run dupes` runs in `harness/` on a tree with no copy at or above
  the floor
- **THEN** it exits with status 0

#### Scenario: A copy at or above the floor fails the run

- **GIVEN** a change adds to `harness/src` a copy of a block that reaches both
  the configured token count and the configured line count
- **WHEN** `bun run dupes` runs
- **THEN** it exits with a non-zero status

#### Scenario: An empty scan fails the run

- **GIVEN** a configuration change leaves the scan with no file to analyze
- **WHEN** `bun run dupes` runs
- **THEN** it exits with a non-zero status

### Requirement: CI runs the copy gate in the lint job of the harness

The `lint (harness)` job of the repository lint workflow MUST run
`bun run dupes` after the install of the harness dependencies. A non-zero exit
of the gate MUST fail the job.

#### Scenario: The gate runs in the lint job

- **WHEN** the `lint (harness)` job runs on a pull request
- **THEN** one of its steps runs `bun run dupes`, and a reported copy fails the
  job

### Requirement: A copy that stays duplicated carries its reason

A copy that the scan reports and that the harness keeps MUST carry its reason at
the place the ignore lives: a region that the detector skips MUST hold a comment
with the reason beside it, and an ignore entry of the configuration MUST have
its reason in the same file.

#### Scenario: An ignore region names its reason

- **WHEN** a file of `harness/src` holds a skipped region around a copy
- **THEN** a comment beside the region marker gives the reason the copy stays

#### Scenario: No reason-less exclusion

- **WHEN** `harness/.jscpd.json` is read
- **THEN** every ignore entry carries its reason in the same file, and no entry
  excludes a tree that holds hand-written code of the harness
