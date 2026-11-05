# copy-detection Specification

## Purpose

Gives the duplicate-code gate of cli: a pinned copy detector scans the source
and the scripts of cli, so a pull request that adds a copy above the committed
floor fails the lint job, and a copy that stays duplicated carries its reason
at the ignore site.

## Requirements

### Requirement: cli pins the copy detector and commits its configuration

cli MUST declare `jscpd` as a dev dependency at one exact version. cli MUST
commit a `.jscpd.json` at its root that names, for the code formats of the
`src` and `scripts` trees — TypeScript and TSX — the minimum size of a reported
copy in tokens and in lines. The configuration MUST carry the reason for that
floor, the reason for each ignored tree, the reason that the data formats stay
outside the scan, and the reason that the package-store fixture payloads stay
outside through the format list, inside the configuration file. The reason for
the floor MUST state the measured clone counts at the chosen floor and at the
floors immediately above and below it, so a future calibration re-runs the same
ladder instead of a new judgment. The configuration MUST exclude `dist`,
`dist-docs`, and `node_modules` from the scan, and MUST NOT exclude any tree
that holds hand-written code of cli.

#### Scenario: The configuration names the floor and its reasons

- **WHEN** `cli/.jscpd.json` is read
- **THEN** it holds a minimum token count and a minimum line count for a
  reported copy, and the reason for the floor, for each ignored tree, for the
  data formats left out, and for the fixture payloads that the format list
  keeps outside sits in the same file

#### Scenario: The reason records the calibration ladder

- **WHEN** `cli/.jscpd.json` is read
- **THEN** the reason for the floor states the measured clone counts at the
  chosen floor and at the floors immediately above and below it

#### Scenario: Data formats stay outside the gate

- **WHEN** the scan runs over `src` and `scripts`
- **THEN** it analyzes no JSON, YAML, or plain-text file, because a fixture
  repeats data and not code, and it analyzes no file of the package-store
  fixtures, because their payloads are third-party package data and not cli
  code

### Requirement: The dupes script fails when the scan reports a copy

The cli script `bun run dupes` MUST run the detector over the `src` and
`scripts` trees and exit with status 0 only when the scan reports no copy at or
above the floor. It MUST exit with a non-zero status when the scan reports such
a copy. It MUST exit with a non-zero status when the scan analyzes no file, so
a configuration drift that matches nothing cannot pass as a clean run.

#### Scenario: A clean tree passes

- **WHEN** `bun run dupes` runs in `cli/` on a tree with no copy at or above
  the floor
- **THEN** it exits with status 0

#### Scenario: A copy at or above the floor fails the run

- **GIVEN** a change adds to `cli/src` a copy of a block that reaches both the
  configured token count and the configured line count
- **WHEN** `bun run dupes` runs
- **THEN** it exits with a non-zero status

#### Scenario: An empty scan fails the run

- **GIVEN** a configuration change leaves the scan with no file to analyze
- **WHEN** `bun run dupes` runs
- **THEN** it exits with a non-zero status

### Requirement: CI runs the copy gate in the lint job of cli

The `lint (cli)` job of the repository lint workflow MUST run `bun run dupes`
after the install of the cli dependencies. A non-zero exit of the gate MUST
fail the job.

#### Scenario: The gate runs in the lint job

- **WHEN** the `lint (cli)` job runs on a pull request
- **THEN** one of its steps runs `bun run dupes`, and a reported copy fails the
  job

### Requirement: A copy that stays duplicated carries its reason

A copy that the scan reports and that cli keeps MUST carry its reason at the
place the ignore lives: a region that the detector skips MUST hold a comment
with the reason beside it, and an ignore entry of the configuration MUST have
its reason in the same file.

#### Scenario: An ignore region names its reason

- **WHEN** a file of `cli/src` holds a skipped region around a copy
- **THEN** a comment beside the region marker gives the reason the copy stays

#### Scenario: No reason-less exclusion

- **WHEN** `cli/.jscpd.json` is read
- **THEN** every ignore entry carries its reason in the same file, and no entry
  excludes a tree that holds hand-written code of cli
