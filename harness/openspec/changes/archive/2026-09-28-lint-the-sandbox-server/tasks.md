# Tasks

## 1. Tools and generated configuration

- [x] 1.1 In `images/sandbox-base/server`, make `tools/go.mod` with module path `github.com/inflexa/sandbox-server/tools`, and set its `go` line to `1.26.0` with `go mod edit`. Then add `inflexa-lint` and `inflexa-lint-config` at `v0.3.0` as tools with `go get -modfile=tools/go.mod -tool`. Make sure that `go tool -modfile=tools/go.mod inflexa-lint version` prints `v2.14.0+golint.v0.3.0`. Make sure that the `go` line of `tools/go.mod` is `1.26.0`.
- [x] 1.2 Run `go get github.com/quasilyte/go-ruleguard/dsl` in the server module, then `go tool -modfile=tools/go.mod inflexa-lint-config`, then `go mod tidy`. Make sure that `.golangci.yml` and `golangci/rules.go` exist, and that `go.mod` has the dsl module as a direct requirement. Make sure that `go list ./...` lists only `github.com/inflexa/sandbox-server`, and that `inflexa-lint-config -check` exits with status 0.

## 2. Tests on each platform

- [x] 2.1 Make `TestExecCompletion_CarriesResourceUsage` in `executor_test.go` skip when `runtime.GOOS` is not `linux`, with a message that gives the reason. Keep the test body. Make sure that `go test ./...` passes on macOS.

## 3. Lint findings

- [x] 3.1 Fix the mechanical findings: `gofmt`, `goimports`, `modernize`, `intrange`, `unconvert`, `staticcheck`, `revive` (`extractTraceId` to `extractTraceID`), and `unused`. Run the lint for Linux with `GOOS=linux "$(go tool -modfile=tools/go.mod -n inflexa-lint)" run ./...`. Make sure that no issue of these linters remains, and that `go test ./...` passes.
- [x] 3.2 Fix the error findings: `errcheck`, `blankerr` (handle the error, or give a `// SAFETY:` comment), `errorlint`, and `errtext`. Make sure that the lint for Linux shows no issue of these linters, and that `go test ./...` passes.
- [x] 3.3 Resolve the `forbidigo`, `boundedfanout`, and `gosec` findings by the finding policy of design.md. Set `ReadHeaderTimeout` to a named 30 s constant for G112. Keep each `// codeql[...]` marker. If an overlay exists, run `inflexa-lint-config` again. Make sure that the lint for Linux reports zero issues, and that `inflexa-lint-config -check` exits with status 0. Make sure that `go vet ./...`, `GOOS=linux go vet ./...`, and `go test ./...` pass.
- [x] 3.4 Make sure that the `Dockerfile` needs no edit, and that `CGO_ENABLED=0 GOOS=linux go build -o <path under tmp/claude/> .` succeeds in the server directory. Remove the binary after the build.
- [x] 3.5 If `podman` or `docker` already runs on the machine, run `go test ./...` one time for Linux in a throwaway container. Use the image `golang:1.26-bookworm`, mount the server directory, and remove the container after the run. Make sure that the suite passes, and that the resource-usage test runs and does not skip. Do not start a container machine or a daemon. If no runtime runs, report that the CI run of the pull request is the first Linux run.

## 4. CI workflow

- [x] 4.1 Add `.github/workflows/sandbox-server.yml` as design.md gives it. It has the triggers `pull_request` and `push` to `main` with the path filter, `permissions: contents: read`, and a concurrency group. It uses the pinned `checkout` and `setup-go` actions, with `go-version-file` and a `cache-dependency-path` for both `go.sum` files. It runs the four steps in the order of the spec, in the server directory. Make sure that the YAML parses, for example with `ruby -ryaml -e 'YAML.load_file(ARGV[0])'`. Run each step command locally in the server directory, and use the Linux `-n` form for the lint step. Make sure that each one passes.

## 5. Claude Code hook

- [x] 5.1 Add `.claude/hooks/sandbox-server-check.ts` (bun) with the edit event and the stop event of design.md. The script checks the path before any process, writes the mark first, formats with `inflexa-lint fmt`, and lints for Linux with `--allow-serial-runners` through the `go tool -n` binary path. The stop event runs the four checks, applies the `stop_hook_active` rules, and builds the failure summary for `go test`. Each notice and each block uses the channel that design.md names.
- [x] 5.2 Do a check of each spec scenario of the two hook requirements, the toolchain requirement, and the lock requirement. Pipe hook input JSON into `bun .claude/hooks/sandbox-server-check.ts`, and use a unique test `session_id`. Cover a TypeScript path, a Go path outside the server, a clean server Go file, and a server Go file with a lint issue. Also cover a server Go file that the formatter changes. For the stop event, cover no mark, a mark with passing checks, a mark with a failing test and `stop_hook_active` false, and a mark with a failing test and `stop_hook_active` true. Cover a PATH that has no `go`, at an edit and at a stop. Make sure of the exit status, the stdout JSON, the stderr text, and the presence of the mark after each case. Undo each temporary code change, and remove each test mark.
- [x] 5.3 Register the script in `.claude/settings.json`. Add a `PostToolUse` handler for matcher `Write|Edit|MultiEdit` with `"if": "Edit(//**/images/sandbox-base/server/**/*.go)"`. Add a `Stop` handler with no `if`. Give each one `timeout` 300 and a `statusMessage`. Keep the existing STE hooks as they are. Make sure that the file is valid JSON and that the existing entries did not change.

## 6. Final verification

- [x] 6.1 In the server directory, run `go vet ./...`, `GOOS=linux go vet ./...`, `inflexa-lint-config -check`, the lint for Linux, and `go test ./...`. Make sure that each one exits with status 0. Make sure that `git status` shows no change outside the paths that proposal.md names, and no scratch output in the repository.
