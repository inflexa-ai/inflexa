## Why

The local server had two start commands: `inflexa serve` in the foreground of a terminal, and `inflexa serve --detach` in the background. Each client starts the server in the background already, and `inflexa server logs --follow` shows its output. The foreground mode held a terminal open and needed its own start path, a re-run of the process with a larger file pool. `inflexa server stop` had no `start` beside it.

## What Changes

- **BREAKING**: `inflexa serve` is removed. `inflexa server start` starts the server in the background.
- The client start and the detached child use `inflexa server start`.
- The re-run of the foreground server with a larger file pool is removed. The detached start gives the pool in the environment of the child.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the start command, the file pool, the server commands, and the log.
- `agent-cli-tool`: the agent policy of the start command.
- `cli-e2e-coverage`: the start command that a client error names.
- `cliproxy-credential-health`: the boot has no terminal.
- `analysis-lock`: the stop of the server has no Ctrl+C.

## Impact

`cli/src/cli/index.ts`, `cli/src/server/serve.ts`, `cli/src/client/server.ts`, `cli/src/lib/child_flags.ts`, `cli/src/index.ts`, and the tests of each. `cli/src/lib/fs_pool_reexec.ts` is removed.
