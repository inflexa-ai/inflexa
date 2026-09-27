# Proposal

## Why

The sandbox server in `images/sandbox-base/server` is the only Go component of
the repository, and no check runs on it: CI runs no `go vet`, no `go test`, and
no linter (GitHub issue #602). The public module
`github.com/inflexa-ai/lint/golint` gives golangci-lint with the shared Go rules
of Inflexa compiled in. The user also wants the same check in a Claude Code
session, after a turn that changed Go code. The sibling repository `himmel` runs
ESLint the same way from its `.claude/hooks`. The repository is mostly
TypeScript, thus the Go check must start only when a Go file of the server
changed.

## What Changes

- Install `inflexa-lint` and `inflexa-lint-config` (golint `v0.3.0`) as tools in
  a separate module file, `images/sandbox-base/server/tools/go.mod`. Add
  `github.com/quasilyte/go-ruleguard/dsl` to the server `go.mod`.
- Generate and commit `.golangci.yml` and `golangci/rules.go` with
  `inflexa-lint-config`.
- Fix each finding of the first lint run. Some findings have no fix that keeps
  the exec protocol. Such a finding gets a `//nolint:<linter> // <reason>`
  directive. If one rule flags the same sanctioned idiom at many sites, it gets
  an exclusion in `golangci/overlay.yml`.
- Make the Linux-only resource-usage test skip on a platform where the server
  reports no usage. Then `go test ./...` passes on a macOS developer machine.
  The test fails there today, and the new session check runs the tests.
- Add a CI workflow for the server on a GitHub-hosted runner. It runs
  `go vet ./...`, `go test ./...`, `inflexa-lint-config -check`, and
  `inflexa-lint run ./...`. It starts only when the server or the workflow
  changes.
- Add a Claude Code hook for the server:
  - After an edit of a `.go` file under the server, it formats that file and
    lints the server. It gives each finding back to the agent.
  - The agent can stop after a session that edited a `.go` file of the server.
    At that stop, the hook runs the CI checks, and a failure prevents the stop.
  - Each other edit, and each other stop, starts no Go toolchain.

## Capabilities

### New Capabilities

- `sandbox-server-lint`: the golint gate of the sandbox server. It covers the
  tools, the generated configuration, the clean lint state, and the CI job. It
  also covers the Claude Code check that runs only for Go edits of the server.

### Modified Capabilities

None. The lint fixes keep each requirement of `sandbox-server` as it is.

## Impact

- `images/sandbox-base/server/`: new `tools/go.mod` and `tools/go.sum`, new
  `.golangci.yml` and `golangci/rules.go`, a new requirement in `go.mod` and
  `go.sum`, and lint fixes across the `.go` files. The `Dockerfile` copies only
  the top-level `*.go` files and builds without the `ruleguard` tag. Thus the
  `Dockerfile` does not change, and the binary changes only by the lint fixes.
  `go mod download` in the image build fetches one more small module.
- `.github/workflows/`: one new workflow for the server. It starts only for a
  change of the server, thus it cannot be a required check.
- `.claude/settings.json` and `.claude/hooks/`: one new hook script, registered
  for `PostToolUse` and `Stop`.
- A developer who edits the server in a Claude Code session needs the Go
  toolchain. A missing toolchain gives a notice, not a block.
