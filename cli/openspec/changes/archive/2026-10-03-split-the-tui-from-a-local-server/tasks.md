## 1. The server process

- [x] 1.1 Add `inflexa serve`. Bind `127.0.0.1` on the port of the build channel. Then write the discovery file with a new bearer token, and boot the runtime with no analysis.
- [x] 1.2 Add the HTTP app: the bearer check, the error body, the list envelope, the SSE helper with `: open` and `: ping`, and the lift of the idle timeout.
- [x] 1.3 Add the routes of each domain under `/api/v1`, and the wire types of each domain in `src/api/`.
- [x] 1.4 Add the guard of each analysis route: 404 for an unknown analysis, and the instance lock at the first request.
- [x] 1.5 Add the turn registry, the busy gate, and the profile queue for each analysis.
- [x] 1.6 Start the re-profile after an input change, and the 10-second flush of the pending package adds, in the server.
- [x] 1.7 Add the stop: the shutdown route with the modes `now` and `drain`, the activity route, and 503 `draining` for a new turn.
- [x] 1.8 Add `inflexa serve --detach`, with the server log and its turnover at 10 MiB.

## 2. The client

- [x] 2.1 Read the discovery file at each request, and probe the server that it names.
- [x] 2.2 Start a server when none answers, under the `server-spawn` lock. Refuse a server of a different API version.
- [x] 2.3 Add a fetcher file for each domain in `src/client/`.
- [x] 2.4 Move the action of each `instance` command that held server state to `src/client/commands/`. Make `geo download` resolve its analysis through the server.
- [x] 2.5 Add `inflexa server status`, `server stop`, and `server logs`. Stop the old server after `inflexa upgrade`. Refuse `inflexa down` while a server answers.
- [x] 2.6 Add the command kind to `registerAction`, and pin it in the snapshot of the registry.
- [x] 2.7 Add the lint rule of the client import boundary, with a test against the real config.

## 3. The TUI

- [x] 3.1 Read the boot phase from `GET /api/v1/server`, and boot no runtime in the TUI process.
- [x] 3.2 Run each chat turn through `POST {A}/chat`. Abort it, retract it, and answer an ask through the routes.
- [x] 3.3 Remove the write queue of each thread and the run-outcome record.
- [x] 3.4 Make the sidebar, the activity panel, the profile parity, the sandbox gate, and the dialogs read the routes on their edges.

## 4. The dev commands

- [x] 4.1 Make the `chat` REPL a client of the chat route, and let it answer an ask.
- [x] 4.2 Make `profile` and `run --status` clients of the routes.
- [x] 4.3 Keep `run --plan` as a `machine` run with its own runtime.

## 5. The tests

- [x] 5.1 Set `INFLEXA_SERVER_FILE` in the test preload, so that no test starts a real server.
- [x] 5.2 Add `startTestServer` for an e2e test of an `instance` command, and `fakeClient` for a test of a client.
- [x] 5.3 Move the e2e tests of the `instance` commands to a test server.

## 6. The specs and the documents

- [x] 6.1 Add the `local-server` spec, and change each cli spec that the split makes false.
- [x] 6.2 Update the sections "Project structure", "The `dev/` subdirectory", and the event bus in `cli/CLAUDE.md`, and add the section "The local server".
- [x] 6.3 Update the structure in `cli/CONTEXT.md`.
