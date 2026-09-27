# Design

## Context

See `proposal.md` for the motivation. These facts shape the approach:

- The server is one Go package, `main`, in module
  `github.com/inflexa/sandbox-server` (`go 1.26`). Some files build only on Linux
  (`provenance_inotify_linux.go`, `resource_usage_linux.go`). Each has a stub for
  other platforms.
- The `Dockerfile` copies `go.mod`, `go.sum`, and the top-level `*.go` files, and
  it builds with `CGO_ENABLED=0 GOOS=linux`. A new file in a subdirectory, or a
  new tools module, does not enter the image.
- On macOS, `go test ./...` fails today at `TestExecCompletion_CarriesResourceUsage`
  (`executor_test.go`). `resource_usage_other.go` returns no usage frame off Linux
  by design, and the test does not skip. CI never ran the Go tests, thus nobody saw
  the failure.
- A probe run of golint `v0.2.0` on a copy of the server gave 111 issues for
  Linux. The pinned version is `v0.3.0`, which the user asked for. Its base
  configuration differs from `v0.2.0` only by the removal of `gocognit`, and the
  probe had no `gocognit` issue. The largest groups are `blankerr` (31), `errcheck` (22), `modernize`
  (17), and `gosec` (11). The others are `intrange`, `forbidigo`,
  `boundedfanout`, `staticcheck`, `errorlint`, `gofmt`, `goimports`, `revive`,
  `unused`, `unconvert`, and `errtext`. A warm lint run takes less than 1 s, and
  a warm `go vet` takes less than 1 s. The test suite takes about 13 s.
- `GOOS=linux go tool -modfile=tools/go.mod inflexa-lint run ./...` fails on
  macOS with `exec format error`. `go tool` builds the tool for the target
  `GOOS`, and the host cannot run a Linux binary. The note of the issue ("set
  `GOOS=linux` for a local run") thus does not work as written.
- The repository has one Claude Code hook, `.claude/hooks/ste-check.ts`. It is a
  bun TypeScript script that serves more than one hook event from one file, and
  `.claude/settings.json` registers it. The reference setup in `himmel` has a
  `PostToolUse` hook that formats and lints the edited file. Its `Stop` hook runs
  the full checks when a per-session marker of the edit hook exists.
- The Claude Code hook schema has an `if` field on a hook handler. It holds one
  permission rule, and Claude Code evaluates it only on tool events, not on
  `Stop`. An `Edit(...)` rule applies to each built-in tool that edits files.
  A `//` prefix anchors the pattern at the root of the file system.

## Goals / Non-Goals

**Goals:**

- A clean golint state of the server, which CI and a Claude Code session keep.
- No Go process for a session turn that did not edit a Go file of the server.
  Where Claude Code can filter the call, no hook process either.

**Non-Goals:**

- Turn on the repository-specific analyzers (`typedids`, `keyowner`, `rawhttp`,
  `testplacement`). The server has no typed ID package, no shared keys, and no
  `tests` folder.
- Detect a Go edit that the agent makes through the shell (for example `sed` or
  `gofmt -w`). Only the built-in file edit tools mark a session. CI still checks
  each such change.
- Change the observable exec protocol of the `sandbox-server` capability.

## Decisions

### The capability lives in the harness spec tree

The `sandbox-server` capability is in `harness/openspec/specs/`, and the root has
no spec tree. The lint gate is a new capability, `sandbox-server-lint`, next to
it. The repository already specifies lint and CI gates as requirements, for
example `result-types` and `cli-reference-docs` in the cli tree.

### The tools module pins golint, and its Go line matches the server

`tools/go.mod` has the module path `github.com/inflexa/sandbox-server/tools`.
`go mod init` writes the version of the local toolchain (for example `1.27.1`).
Set the `go` line to `1.26.0` with `go mod edit` before `go get`, which is the
minimum of golint `v0.3.0`. Then the Go 1.26 toolchain that CI installs from the
server `go.mod` runs the tools with no toolchain switch.

After `inflexa-lint-config` writes `golangci/rules.go`, run `go mod tidy` in the
server module. Tidy reads the `ruleguard` build tag and makes the
`go-ruleguard/dsl` requirement direct. `go list ./...` does not list the
`golangci` package, because the build tag excludes each of its files.

### The finding policy: fix, then suppress with a reason

Fix each finding with a change that keeps the observable behavior of the
`sandbox-server` capability. These fixes are the expected form:

- `blankerr`: handle the error, or state in a `// SAFETY:` comment why the
  discard is safe.
- `errcheck`, `errorlint`, `staticcheck`, `unconvert`, `modernize`, `intrange`,
  `gofmt`, and `goimports`: the change that the linter names.
- `revive` `var-naming`: rename `extractTraceId` to `extractTraceID`.
- `unused`: remove the unused method.
- `forbidigo` on `context.Background`: detach from the caller context with
  `context.WithoutCancel`, where a caller context exists. The root context of
  `main` has no caller.
- `gosec` G112: set `ReadHeaderTimeout` on the `http.Server` to a named
  constant of 30 s. It bounds only the time to receive the request headers, the
  same as the body cap bounds the body of a peer. No host client sends slow
  headers, and the idle time between requests does not change.

- `forbidigo` on `time.Sleep` (`provenance_inotify_linux.go`): wait with a
  `select` on the stop channel and a timer, where a stop channel exists. The
  wait interval does not change.
- `boundedfanout`: first try a join (`sync.WaitGroup`) or a type with a `Stop`
  method. Use it only when the shutdown of the server does not wait longer than
  today. A callback retry can continue for a long time, thus a join on an exec
  goroutine can make the shutdown wait. In that case, suppress the finding.

Some findings conflict with the purpose of the server. Suppress such a finding at
its site with `//nolint:<linter> // <reason>`. Examples:

- `gosec` G204: the server runs the command that the signed caller supplies.
  Keep the existing `// codeql[go/command-injection]` marker at each site.
- `boundedfanout` on the exec goroutine: the submit-and-return contract makes the
  goroutine outlive the request, and the process lifetime bounds it.

If one rule flags the same sanctioned idiom at many sites, add an exclusion rule
with a reason comment to `golangci/overlay.yml`, and run `inflexa-lint-config`
again. Do not put a directive at each site. The golint README permits exclusion
rules in the overlay, and an overlay list comes after the base list. `nolintlint` rejects a directive with no reason, or one that
suppresses nothing.

A finding that needs a change of the specified protocol is out of scope. If one
appears, stop and report it.

### The resource-usage test skips off Linux

`TestExecCompletion_CarriesResourceUsage` skips when `runtime.GOOS` is not
`linux`, with a message that the server reports no usage frame off Linux. A
`//go:build linux` test file is the alternative, but it moves the test and
hides it from a reader of `executor_test.go`. The skip is the smaller change.

### The CI workflow is a separate file with a path filter

The user chose this form. `.github/workflows/sandbox-server.yml` runs on
`pull_request` and `push` to `main`, with `paths` set to
`images/sandbox-base/server/**` and the workflow file. `installers.yml` and
`citation-sync.yml` already use a `paths` filter. One job,
`check (sandbox-server)`, runs on `ubuntu-latest` with
`working-directory: images/sandbox-base/server`. It runs these steps in the
order of the spec, which the stop hook also uses:

1. `go vet ./...`
2. `go tool -modfile=tools/go.mod inflexa-lint-config -check`
3. `go tool -modfile=tools/go.mod inflexa-lint run ./...`
4. `go test ./...`

The workflow obeys the conventions of `lint.yml`: `permissions: contents: read`,
a concurrency group that cancels a superseded run, and actions pinned by SHA with
the version in a comment. The actions are
`actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0` and
`actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0`.
`setup-go` reads `go-version-file: images/sandbox-base/server/go.mod`, and its
`cache-dependency-path` names `go.sum` and `tools/go.sum`. A `uses:` step
ignores `working-directory`, thus these paths start at the repository root.

Alternative: a job in `lint.yml` and `test.yml`. Those workflows run on each
pull request, and a job cannot filter by path without a third-party action. The
user rejected a Go job on each TypeScript-only change. The user also accepted
that a path-filtered workflow cannot be a required check.

### One hook script serves the edit event and the stop event

`.claude/hooks/sandbox-server-check.ts` is a bun TypeScript script, the same as
`ste-check.ts`. It reads the hook input from stdin and dispatches on
`hook_event_name`. `.claude/settings.json` registers it two times:

- `PostToolUse`, matcher `Write|Edit|MultiEdit`, with
  `"if": "Edit(//**/images/sandbox-base/server/**/*.go)"`, `timeout` 300, and a
  `statusMessage`.
- `Stop`, with no `if` field, because Claude Code never runs a `Stop` handler that
  has one. `timeout` 300, and a `statusMessage`.

The command is `bun "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/sandbox-server-check.ts"`,
the same form as the existing hook. The long timeout covers the first build of
`inflexa-lint`, which compiles golangci-lint. A warm run takes about 1 s.

The `//` prefix anchors the rule at the root of the file system, thus the rule
does not depend on the working directory of the session. A rule with no prefix
resolves against the current directory, which changes when the agent enters a
subsystem. A `/` prefix resolves against the primary working directory, which is
a subsystem when the session starts there. The script
still checks the path itself: the absolute path must start with
`<project>/images/sandbox-base/server/` and end with `.go`. Otherwise it exits
with status 0 before it starts a process. This check covers a Go file elsewhere
and a Claude Code version that ignores `if`.

Alternative: a `node` `.mjs` script, as in `himmel`. The repository already runs
its hook with bun, and `.bun-version` pins bun.

### The edit event formats, marks, then lints

For a server Go file, the edit event does these steps:

1. Write the session mark, before any process starts.
2. Run `inflexa-lint fmt <file>`. It applies the formatters of `.golangci.yml`
   (`gofmt` and `goimports` with the local prefix). Compare the bytes before and
   after.
3. Run `inflexa-lint run --allow-serial-runners ./...` for Linux in the server
   directory.
4. If the lint reports issues, exit with code 2, with the lint output on stderr.
   If step 2 changed the file, the same stderr message starts with the notice
   that the file on disk differs from the text of the agent.
5. If the lint passes and step 2 changed the file, print
   `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}`
   on stdout with the notice, and exit with status 0. `himmel` uses the same
   form. Plain stdout on exit 0 goes only to the debug log.

`--allow-serial-runners` makes a second golangci-lint wait for the lock of the
machine. Without it, a parallel run of another session or another checkout
fails after 5 s with "parallel golangci-lint is running". golangci-lint exits
with status 1 when it reports issues. Treat another non-zero status as a lint
that did not run, and give a notice.

The lint covers the whole module, not only the edited file. golangci-lint
analyzes a package with its type information, and the server is one package. A
filter to the edited file would hide a break that the edit caused in a caller.

### The script runs the lint binary for Linux through its path

The script resolves the binary with
`go tool -modfile=tools/go.mod -n inflexa-lint`. That command builds the tool for
the host, if necessary, and prints its path. The script then runs that binary
with `GOOS=linux` in its environment. `go vet` takes `GOOS=linux` directly,
because it only analyzes. `go test` runs for the host, because the host cannot
run a Linux test binary.

### The session mark is a file in the temporary directory

The mark is `<os.tmpdir()>/inflexa-claude-hooks/sandbox-server-<session_id>`. The
script replaces each character outside `[A-Za-z0-9_-]` in the session ID. The
mark means that a Go edit of the server has no check yet. The edit event writes
the mark before any process, thus a failed lint or a missing toolchain still
marks the session. The stop event does these steps:

1. If the mark does not exist, exit with status 0. This costs one file check and
   starts no Go process.
2. Run the four checks in the order of the spec, and stop at the first failure.
   The lint step uses `--allow-serial-runners`.
3. If each check passes, remove the mark and exit with status 0.
4. If a check fails and `stop_hook_active` is false, write the failure message
   to stderr and exit with code 2. The mark stays, thus the stop after the fix
   checks again.
5. If a check fails and `stop_hook_active` is true, remove the mark. Print the
   failure message as `{"systemMessage": "..."}` on stdout, and exit with status
   0. The agent stops, and the user sees the failure.

Thus each stop that lets the agent stop leaves no mark. A later turn with no Go
edit starts no Go process.

`stop_hook_active` can also come from a different `Stop` hook that blocked. The
Go check ran at that first stop too, in parallel, thus its failure already
reached the agent.

The failure message names the command. For `go test`, it lists each line that
starts with `--- FAIL`, `FAIL`, or `panic:`, each indented `<name>_test.go:<line>:`
line, and each `<file>.go:<line>:<column>:` build error. Then it adds the last
20 lines. The server tests log each callback retry, thus the end of the output
alone holds only log lines. For the other checks, the message holds the end of
the output. Each message holds a maximum of 200 lines.

The Claude Code docs give each tool call of a subagent the session ID of the
parent. A subagent fires `SubagentStop`, not `Stop`, thus the parent checks at
its own stop.

Alternative: `scratchpad_dir` of the hook input. Claude Code gives it only from
v2.1.257, and the field can be absent. Alternative: `git status` at each stop. Then an
uncommitted Go change of an earlier turn, or of the user, starts the checks at
each later stop. A TypeScript-only turn would pay for them too.
Alternative: the `node_modules/.cache` of `himmel`. The repository root has no
`node_modules`.

### A toolchain failure gives a notice, not a block

If a process cannot start (for example, no `go` on the PATH), or if
`go tool -n inflexa-lint` fails, the check did not run. The script prints
`{"systemMessage": "..."}` with the cause on stdout, and it exits with status 0.
This is the form that `ste-check.ts` uses for a hook that did not run. A failed `inflexa-lint fmt` does not stop the edit event. The formatter exits 0
on a syntax error, and it fails only when it cannot process the file, for example
a removed file. The lint still gives the result. Its output joins the block message when the lint
blocks, and it becomes a notice when the lint passes. The edit
event keeps the mark. The stop event removes the mark after the notice, thus a
later turn with no Go edit does not show the notice again. A non-zero exit of
`go vet`, of the tests, or of the resolved config check is a finding. Only a
failure of `go tool -n` for a tool is a toolchain failure. A lint exit status of
1 is a finding.


## Risks / Trade-offs

- [The path filter makes the workflow absent on a pull request that does not
  touch the server. A required status check with that name would then wait
  forever.] → Do not make the check required. Branch protection is the task of
  the user.
- [No task runs the full suite on Linux before the pull request, unless a local
  container runtime is available.] → The tasks run the suite one time in a
  throwaway `golang:1.26-bookworm` container when podman or docker already runs.
  Otherwise, the first Linux run is the CI run of the pull request.
- [The first edit hook of a machine compiles golangci-lint, which takes some
  minutes.] → The 300 s timeout covers the build. After a timeout, the Go build
  cache keeps the compiled packages, thus the next call continues.
- [A shell edit of a Go file does not mark the session.] → CI checks each change.
  `himmel` has the same limit.
- [The lint after an edit covers the module. It can report an issue in a file
  that the agent plans to edit next.] → The feedback names the file and the line. The
  agent continues, and the stop check gives the final result.
- [The `if` rule can match `Write` differently in a future Claude Code version.]
  → The path check in the script and the stop check still apply. No task starts
  a live Claude Code session to observe the filter.
- [`go test` adds about 13 s to a stop after a Go edit.] → Only a session that
  edited a server Go file pays it.
