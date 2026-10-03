# Split the TUI from a local server

## Why

The TUI booted the harness runtime in its own process. Thus only one TUI could open the data of an analysis, and no other client could see its work. A web GUI cannot embed the runtime.

## What Changes

- One local server for each user and each build channel holds the harness runtime and the local stores. The TUI, the instance commands, and a later GUI are clients of its HTTP API under `/api/v1`.
- A client starts `inflexa serve --detach` when no server answers. The server runs until `inflexa server stop`. The discovery file `server.json` gives its port and its bearer token.
- The new commands `serve`, `server status`, `server stop`, and `server logs` start, inspect, and stop the server. `inflexa upgrade` stops the old server, and `inflexa down` refuses while a server answers.
- Each command declares its kind: `instance`, `machine`, or `standalone`. The `store`, `sandbox`, and `refs` commands run with no server, because cloud jobs run them. `store link` is the exception.
- A lint rule keeps `src/tui/` and `src/client/` away from `src/db/`, `src/server/`, the bus, and the modules that hold state.
- A route keeps the path tail of Cortex where Cortex does the same work.
- The TUI reads endpoints on its poll edges, because the bus stays in the server process.
- The server adds no guarantee beyond the harness and Cortex. Thus the write queue of each thread and the run-outcome record are gone.
- The dev `chat` REPL is a client of the chat route, and it can answer an ask. The dev `profile` and `run --status` are clients. The dev `run --plan` boots its own runtime.

## Capabilities

### New Capabilities

- `local-server`: the server process and its lifecycle, the `server` commands, the client import rule, and the conventions of its HTTP API.

### Modified Capabilities

- Command surfaces: `cli-core`, `agent-command-policy`, `agent-cli-tool`, `dev-commands`, `chat-command`, `command-palette`, `projects`, `move-backstop`, `geo-input-download`, `usage-breakdown`, `llm-usage-ledger`, `prov-verify`, `prov-lineage`.
- The TUI chat: `tui-harness-chat`, `tui-ask-approval`, `run-completion-notice`, `chat-view`, `chat-wiring`, `workspace-context`, `sidebar-live`, `artifact-open`, `agent-model-selection`.
- The runtime and its state: `harness-runtime`, `analysis-lock`, `event-bus`, `context-resolution`, `analysis-service`, `analysis-input-management`, `data-profile-launch`, `analysis-run-launch`, `path-resolution`, `data-model-db-access`, `structured-logging`.
- The machine and the store: `farm-composition`, `package-store-management`, `postgres-provisioning`, `infra-state-resilience`, `model-connection`, `cliproxy-credential-health`, `local-embeddings`.
- The tests: `test-harness`, `cli-e2e-coverage`.

## Impact

- New code: `cli/src/server/`, `cli/src/client/`, `cli/src/api/`.
- Changed code: `cli/src/cli/`, `cli/src/tui/`, `cli/src/modules/`, `cli/src/test_support/`, `cli/eslint.config.js`.
- A new direct dependency: `hono`.
- The harness change `end-a-canceled-run-stream-and-resolve-the-farm-lock` gives the canceled terminal part of the run stream and the farm lock path for each analysis.
- The open changes `adopt-the-harness-chat-turn`, `render-report-entry-from-part`, `analysis-purge-and-session-restore`, and `fix-windows-compose-stack` modify requirements that this change also modifies.
