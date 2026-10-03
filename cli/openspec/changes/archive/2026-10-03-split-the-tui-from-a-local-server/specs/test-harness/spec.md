## ADDED Requirements

### Requirement: A test never starts a real local server

The test preload SHALL set `INFLEXA_SERVER_FILE` to a discovery file inside the test sandbox. Under that variable a client only connects to the server that the file names, and never starts one in the background. Thus an instance command that a test runs with no test server SHALL fail at its server check, and SHALL NOT spawn a server that binds the dev port and boots the containers.

#### Scenario: An instance command with no test server fails fast

- **WHEN** a test runs an instance command as a subprocess and no test server answers
- **THEN** the command exits non-zero with the instruction to start a server, and no server process starts

### Requirement: Test server helper

The harness SHALL provide a helper that starts the HTTP app of the local server inside the test process, for an end-to-end test of an instance command. It SHALL bind `127.0.0.1` on a port that the OS picks, write a new discovery file with a new token into a new folder inside the test sandbox, and give the env that a child needs to find it (`INFLEXA_SERVER_FILE`). Thus two test servers never share a port or a discovery file, and a test server never touches the dev port or the dev discovery file.

By default the server SHALL use a boot that never starts: a route that needs the harness runtime answers 503 `unavailable`, and each route that reads or writes SQLite works. A test can pass its own boot for a route that needs the runtime. The routes SHALL read and write the sandboxed SQLite database of the test process, thus a test seeds and asserts through the database layer as before. The helper SHALL stop the listener and remove the folder of the discovery file at its stop.

#### Scenario: A child command reaches the test server

- **GIVEN** a test server and a seeded project in the sandboxed database
- **WHEN** the test runs `inflexa project ls` as a subprocess with the env of the test server
- **THEN** the command lists the seeded project

#### Scenario: A runtime route answers unavailable by default

- **WHEN** a test sends a request to a route that needs the runtime, on a test server with the default boot
- **THEN** the server answers 503 `unavailable`

### Requirement: Async CLI subprocess helper

The harness SHALL provide an async variant of the CLI subprocess helper, which spawns the same command line and waits for the exit without a block of the event loop of the test process. A test of an instance command against a test server SHALL use it, because the test server answers from the event loop of the same process, and a synchronous spawn would wait on itself. The async helper SHALL send the output of the child to files and read them after the exit, for the same reason as the synchronous helper.

#### Scenario: An instance command completes against an in-process server

- **WHEN** a test runs an instance command with the async helper and the env of a test server
- **THEN** the helper returns `{ exitCode, stdout, stderr }` of the real process, and the server answered each request of the child
