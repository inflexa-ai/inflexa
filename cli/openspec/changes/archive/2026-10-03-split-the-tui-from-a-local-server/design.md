# Design — split the TUI from a local server

## Context

The TUI booted the harness runtime in its own process. It held the instance lock of its analysis, it subscribed to the bus, and it read SQLite and Postgres directly. A text command opened the same stores in its own process. Thus only one TUI could open an analysis, and a second client could not see the work of the first.

The code of this change is the truth. The draft of the API (`tmp/claude/local-server-api.md`, 2026-10-01) started the work, but the code differs from it in some places. The section "Differences from the draft" lists them.

## Goals / Non-Goals

**Goals:**

- One process holds the runtime and the stores. Each client uses one HTTP API.
- A route keeps the path tail of Cortex when it does the same work, so that a later fix can apply to both hosts.
- The server gives no guarantee that the harness and Cortex do not give together.

**Non-Goals:**

- The web GUI, its browser auth, and a check of the Host and the Origin headers.
- An attach stream for a turn that a different client started.
- A bounded read of the transcript.

## Decisions

### D1 — One server process for each user and each build channel

`inflexa serve` binds `127.0.0.1` on a fixed port: 8431 for a production build and 8436 for a dev build. The bind comes before the discovery file, thus a second server fails at the bind and does not replace the file of the first. The server boots the runtime after the bind, with no analysis. The routes that need only SQLite or the disk answer in each boot phase. The other routes give 503 `unavailable` until the phase is `ready`.

The boot never asks for a provider login. A prompt in the terminal of a background server stops the boot until someone answers it, and no one sees it.

### D2 — The discovery file holds the port and the token

The server writes `server.json` (`server.dev.json` for a dev build) in the data folder, with mode 0600, through a temporary file and a rename. The file holds the pid, the port, a new 256-bit bearer token, the versions, the start time, and the channel. At its exit, the server removes the file only when the file names its own pid.

A client reads the file at each request, thus it sends the new token after a restart. `INFLEXA_SERVER_FILE` names a different file. A client under this variable starts no server, because a different owner starts that server. The test preload and `startTestServer` use it.

### D3 — A client starts the server

Each `instance` command connects to the server before its action runs. When no server answers, the client takes the `server-spawn` lock, reads the file again, and runs `inflexa serve --detach`. A second client that finds the lock held waits for the server that the holder starts. Thus two clients start one server. A server of a different API version is refused, with the remedy `inflexa server stop`.

`inflexa serve --detach` starts the server in a session of its own, with the home folder as its working folder and the server log as its output. The log turns over at 10 MiB to one old file, through a copy and a truncation, because the server keeps its descriptor.

### D4 — No idle exit

The server runs until a stop: `inflexa server stop`, the shutdown route, Ctrl+C, SIGTERM, or SIGHUP. A run executes in the server process after the turn that started it ends. The 10-second flush of the pending package adds also runs there. An idle exit would stop that work while no client watches it.

### D5 — A stop drains or aborts the chat turns

`POST /api/v1/server/shutdown` takes the mode `now` or `drain`. Each mode refuses a new chat turn at once with 503 `draining`. `drain` waits up to 60 s for the running turns. Then the server aborts the turns that still run, waits up to 5 s, and exits. A run is a durable workflow, thus it continues at the next start. `GET /api/v1/server/activity` gives the work that a stop interrupts.

`inflexa upgrade` stops the old server after it replaces the binary. With active work, it asks first in a terminal, and the default is No.

### D6 — The `server` commands

`server status`, `server stop`, and `server logs` are `machine` commands, thus none starts a server. `serve` and `server stop` are `blocked` for the agent, because the conversation runs inside the server. `server status` is `auto` with `--json` as a safe flag. `server logs` is `approval`.

### D7 — Each command declares a kind

`registerAction` takes a `CommandKind` beside the agent policy:

- `instance`: a client of the server
- `machine`: it prepares or controls the machine, the package store, or the server
- `standalone`: it reads a local file or prints a value
- an `instance` kind with machine flags: the dev `run --plan` boots its own runtime

The check of the server runs inside the action. A check in a hook of the root would run during each dry parse of the `run_inflexa` classifier.

The `store`, `sandbox`, and `refs` commands stay `machine` or `standalone`, because a cloud job runs them with no server. `store link` is an `instance` client of `POST {A}/farm/link`, because it changes the farm of an analysis under the farm queue of the server.

### D8 — The client import rule

A lint rule keeps `src/tui/` and `src/client/` away from `src/db/`, `src/server/`, the bus, the harness runtime, and the modules that hold state. The list of permitted imports holds the pure code of the client: the harness contracts, the pure profile view, the plan graph, the part readers, the check of an exported provenance file, and the update module. The rule uses regex patterns, because a glob group cannot permit one file inside a banned folder.

### D9 — The routes by domain

The routes are under `/api/v1`, grouped by domain: the server, the machine, the projects, the anchors, the analyses, one analysis `{A}`, its conversation, its runs, its records, and the package store. `src/api/` holds one file of wire types for each domain, and the route and the fetcher import the same types. The error body is `{error, message, details?}`, the Cortex shape. Each list uses the Cortex thread-list envelope.

The SSE frames are `data: <JSON>`, with `: open` at the start and `: ping` each 5 s. `Bun.serve` sends the headers with the first body bytes and closes a connection that is silent for 10 s. A route that can work longer than 10 s before its response lifts the idle timeout for its request.

The chat route sends the headers when the turn opens, not at the first frame. Thus the sender gets the turn id at once, and it can abort the turn before the model answers.

### D10 — Polls take the place of the bus

The server gives no notification stream, and Cortex gives none. Each TUI poll keeps its schedule and its gate, and it reads an endpoint in place of the database. A push that a client must see becomes state that an endpoint returns. The bus stays inside the server process, where the provenance bridge and the run observer use it.

### D11 — What the server keeps

- The turn registry: the abort controller of each running turn, and the newest 100 ended summaries. Any client can abort a turn.
- The busy gate before a rename or a delete of an analysis. A local rename moves the workspace folder, and a run can still write there.
- The profile queue for each analysis. The harness claim serializes only the dispatch, and the staging before it races.
- The re-profile after an input change from each writer in the process, and the 10-second flush of the pending package adds.
- The instance lock of each analysis, taken at the first `{A}` request and held until exit. It fences an installed binary from before the server, which shares the database and writes the chain of `inputs add` directly.
- The in-process exclusion of a reclamation of the package store. The lock file is re-entrant for one pid, thus a second taker in the server passes it.

### D12 — What the server dropped

- The per-thread write queue. It ordered only the run-outcome record behind a turn, and the harness locks each write of a thread.
- The run-outcome record in the transcript. No harness code and no Cortex code writes it. The completion notice stays a client edge over the polled runs.
- A guard against a second turn on one thread. The harness and Cortex do not serialize turns, and the submit gate of the TUI stays.

## Differences from the draft

The code differs from the draft in these places:

- The draft put the dev token in `server.dev.token` and let no client start a server. The code writes the discovery file `server.json` or `server.dev.json` in each channel, and a client starts the server unless `INFLEXA_SERVER_FILE` is set.
- The draft deferred the lifecycle. The code has the production port 8431, the stop route, the activity route, the `server` commands, no idle exit, and the stop at `inflexa upgrade`.
- The draft made the `store` and `sandbox` commands clients. The code keeps them `machine` commands, except `store link`.
- The draft has no `draining` code. The code adds 503 `draining` for a turn during a stop.
- The draft kept the instance lock only in dev mode. The code takes it in each channel.
- The draft swept each pending ask at boot. The code keeps the default age guard of the sweep.
- The draft sent the chat headers at the first frame. The code sends them when the turn opens.
- `ServerState` carries `provider`, `mode`, and `model` for the connection, and the phase decides which fields exist.
- `POST {T}/purge` takes `files: keep | remove` and reports the fate of the report pages. `GET {A}/chat-context` also gives the outcome of the parity drive.

## Risks / Trade-offs

- An idle client sees the work of a different client only at its next read. The TUI had the same limit with a second process.
- A client that leaves during a turn does not stop the turn. A client that quits sends the abort first.
- A turn abort kills a `run_inflexa` child, but not the server work that the child started, for example a reclamation or a transfer.
- Some store routes have no client in the cli yet, because the `store` commands run in their own process.
