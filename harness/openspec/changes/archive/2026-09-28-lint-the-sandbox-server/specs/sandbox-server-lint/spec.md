# Spec Delta

## Purpose

Keeps the Go source of the sandbox server clean under the shared Inflexa Go
rules (golint). CI and a Claude Code session run the same checks. The session
runs them only after an edit of a Go file of the server.

## ADDED Requirements

### Requirement: The server pins golint and commits the generated configuration

The sandbox server module (`images/sandbox-base/server`) MUST declare
`inflexa-lint` and `inflexa-lint-config` of `github.com/inflexa-ai/lint/golint` at
one pinned version as tools in a separate module file, `tools/go.mod`. The
dependencies of golangci-lint MUST NOT enter the server `go.mod`. The server
`go.mod` MUST require `github.com/quasilyte/go-ruleguard/dsl`, because the
generated ruleguard file imports it.

The server MUST commit `.golangci.yml` and `golangci/rules.go` as
`inflexa-lint-config` writes them from the pinned base and from the optional
overlay `golangci/overlay.yml`. A local lint choice MUST go into the overlay,
never into a hand edit of a generated file.

The ruleguard file MUST NOT enter a build, a test, or a vet of the server. Thus
the lint setup adds no code to the image binary.

#### Scenario: The generated files match the pinned base

- **WHEN** `go tool -modfile=tools/go.mod inflexa-lint-config -check` runs in the server directory
- **THEN** it MUST print nothing and exit with status 0

#### Scenario: A hand edit of a generated file is drift

- **GIVEN** a change edits `.golangci.yml` and does not change the overlay
- **WHEN** `inflexa-lint-config -check` runs
- **THEN** it MUST print `.golangci.yml` and exit with status 1

#### Scenario: The ruleguard file stays out of the build

- **WHEN** `go build ./...`, `go vet ./...`, or `go test ./...` runs in the server directory
- **THEN** the command MUST NOT compile a package of the `golangci/` directory

### Requirement: The server source passes golint for Linux

`inflexa-lint run ./...` MUST report no issue for the server source when it
analyzes the source for Linux (`GOOS=linux`), which is the platform of the
shipped image. A suppression MUST name one linter and give its reason, in a
`//nolint:<linter> // <reason>` directive or in an exclusion rule of the overlay.
A suppression MUST NOT hide a finding whose fix keeps the observable behavior
that the `sandbox-server` capability specifies.

#### Scenario: A clean tree passes

- **WHEN** `inflexa-lint run ./...` runs for Linux in the server directory
- **THEN** it MUST report zero issues and exit with status 0

#### Scenario: A new violation fails the lint

- **GIVEN** a change adds `_ = f.Close()` to a server file with no `SAFETY:` comment
- **WHEN** `inflexa-lint run ./...` runs for Linux
- **THEN** it MUST report a `blankerr` issue at that line and exit with a non-zero status

#### Scenario: A suppression with no reason fails the lint

- **GIVEN** a change adds a `//nolint:errcheck` directive with no reason
- **WHEN** `inflexa-lint run ./...` runs for Linux
- **THEN** it MUST report a `nolintlint` issue

### Requirement: The server tests pass on each developer platform

`go vet ./...` and `go test ./...` MUST pass in the server directory on Linux
and on macOS. A test of behavior that exists only on Linux MUST skip on another
platform, and the skip message MUST give the reason.

#### Scenario: The resource-usage test on macOS

- **GIVEN** a macOS machine, where the server reports no resource usage
- **WHEN** `go test ./...` runs in the server directory
- **THEN** the test of the resource-usage frame MUST skip, and the suite MUST pass

#### Scenario: The resource-usage test on Linux

- **GIVEN** a Linux machine
- **WHEN** `go test ./...` runs in the server directory
- **THEN** the test of the resource-usage frame MUST run and MUST assert a positive peak memory and CPU time

### Requirement: CI checks each change of the server

A GitHub Actions workflow MUST run on a GitHub-hosted Linux runner. It MUST
start for each pull request to `main` and each push to `main` that changes a
file under `images/sandbox-base/server/` or the workflow file itself. In the server
directory it MUST run `go vet ./...`, `inflexa-lint-config -check`,
`inflexa-lint run ./...`, and `go test ./...`. A failure of one of
them MUST fail the workflow. The workflow MUST install the Go version that the
server `go.mod` names.

#### Scenario: A server change starts the checks

- **WHEN** a pull request to `main` changes `images/sandbox-base/server/executor.go`
- **THEN** the workflow MUST run the four checks, and a lint issue MUST fail it

#### Scenario: A change outside the server starts nothing

- **WHEN** a pull request to `main` changes only files under `cli/` and `harness/`
- **THEN** the workflow MUST NOT start

### Requirement: A Claude Code session lints each Go edit of the server

The project Claude Code settings MUST register a `PostToolUse` hook for the
built-in file edit tools. The hook MUST act only on a file that ends in `.go`
and is under `images/sandbox-base/server/`. For such a file it MUST:

1. Record that the session edited a Go file of the server.
2. Format the file with the formatters of the committed lint configuration.
3. Lint the server for Linux.

If the lint reports an issue, the hook MUST give the issues to the agent as
blocking feedback. If the formatter changed the file, the hook MUST tell the
agent that the file on disk differs from the text that the agent wrote. That
notice MUST reach the agent also when the lint blocks.

For each edit of a file that is not a `.go` file under the server, the settings
MUST filter the call out before the hook starts, where the Claude Code version
supports the filter. The hook itself MUST exit before it starts a Go process
when the path is not a `.go` file under the server.

#### Scenario: An edit of a TypeScript file

- **WHEN** the agent edits `cli/src/index.ts`
- **THEN** the hook MUST NOT start a Go process

#### Scenario: An edit of a Go file outside the server

- **WHEN** the agent writes a `.go` file outside `images/sandbox-base/server/`
- **THEN** the hook MUST exit with status 0, and it MUST NOT start a Go process

#### Scenario: An edit that breaks a rule

- **WHEN** the agent edits `images/sandbox-base/server/executor.go` and the lint then reports an issue
- **THEN** the agent MUST receive the issue text as blocking feedback of that edit

#### Scenario: An edit that the formatter changes

- **WHEN** the agent writes a server Go file with import groups in the wrong order and no lint issue remains after the format
- **THEN** the file on disk MUST hold the formatted text, and the agent MUST receive a notice that the file changed

### Requirement: A Claude Code session checks the server before it stops

The project Claude Code settings MUST register a `Stop` hook. The record of a
Go edit means that an edit of a Go file of the server has no check yet. When no
record exists, the hook MUST exit with status 0 before it starts a Go process.
When a record exists, the hook MUST run these checks in the server directory, in
this order, and it MUST stop at the first failure:

1. `go vet ./...` for Linux.
2. `inflexa-lint-config -check`.
3. `inflexa-lint run ./...` for Linux.
4. `go test ./...` on the host.

The result of the checks decides the next step:

- When each check passes, the hook MUST clear the record and let the agent stop.
- When a check fails and `stop_hook_active` is false, the hook MUST prevent the
  stop. The agent MUST receive the failed command and a summary of its output.
  The record MUST stay, thus the next stop checks again.
- When a check fails and `stop_hook_active` is true, the hook MUST let the agent
  stop. This prevents a loop on a failure that the agent cannot fix. The hook
  MUST clear the record and show the failure as a notice.

For a failed `go test`, the summary MUST hold each failed test, each assertion
message of a failed test, each panic, and each build error. The output of the
suite holds many log lines, thus the end of the output alone does not show them.
The summary MUST hold a maximum of 200 lines.

#### Scenario: A turn with no Go edit

- **GIVEN** the session has no record of a Go edit of the server
- **WHEN** the agent stops
- **THEN** the hook MUST exit with status 0, and it MUST NOT start a Go process

#### Scenario: A turn that left a failing test

- **GIVEN** the session edited a server Go file, and `go test ./...` fails
- **WHEN** the agent stops, and `stop_hook_active` is false
- **THEN** the hook MUST prevent the stop
- **AND** the agent MUST receive the command, the name of each failed test, and its assertion message

#### Scenario: A turn that passes the checks

- **GIVEN** the session edited a server Go file, and each check passes
- **WHEN** the agent stops
- **THEN** the hook MUST let the agent stop and MUST clear the record
- **AND** the next stop with no new Go edit MUST NOT start a Go process

#### Scenario: A second stop after a block

- **GIVEN** the hook prevented the previous stop, and a check still fails
- **WHEN** the agent stops again, and `stop_hook_active` is true
- **THEN** the hook MUST let the agent stop, show the failure as a notice, and clear the record
- **AND** a later turn with no Go edit MUST NOT start a Go process

### Requirement: A missing Go toolchain does not block a session

If the hook cannot start the Go toolchain, or it cannot build the lint tool, it
MUST NOT block the edit or the stop. It MUST show a notice that the check did
not run and give the cause. It MUST NOT report the check as passed. The edit
event MUST write the record before it starts a Go process. A stop that cannot
run the checks MUST clear the record after the notice.

#### Scenario: No Go on the PATH at an edit

- **GIVEN** a machine with no `go` command on the PATH
- **WHEN** the agent edits a server Go file
- **THEN** the edit MUST stand, and the session MUST show a notice that the Go check did not run
- **AND** the session MUST have a record of the Go edit

#### Scenario: No Go on the PATH at a stop

- **GIVEN** a machine with no `go` command on the PATH, and a record of a Go edit
- **WHEN** the agent stops
- **THEN** the hook MUST let the agent stop, show a notice that the Go check did not run, and clear the record

### Requirement: A lint that waits for another lint is not a finding

The hook MUST NOT report a finding when a golangci-lint run of another session
or another checkout holds the lint lock of the machine. It MUST wait for the lock.

#### Scenario: Two sessions lint at the same time

- **GIVEN** a lint of another session holds the lint lock
- **WHEN** the agent edits a server Go file
- **THEN** the hook MUST wait for the lock and report only the issues of its own run
