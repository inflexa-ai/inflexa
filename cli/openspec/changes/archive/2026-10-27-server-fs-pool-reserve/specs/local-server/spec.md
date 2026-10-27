# Spec Delta

## ADDED Requirements

### Requirement: The server process runs with a large file pool

The server process MUST request a file pool of at least 64 threads, and at least 4 threads for each core, when the CLI sets the pool. The pool size comes from the variable `UV_THREADPOOL_SIZE` of the process, and the runtime clamps it to 2 to 1024. When the environment of the person already sets the variable, the server MUST keep that value and request nothing. Thus a hung mount that holds the 16 threads of one staging walk, or the reads of one folder list, leaves threads for each other file call of the server.

`inflexa serve --detach` MUST give the value to its detached child in the environment of the child. The foreground `inflexa serve` on a POSIX platform MUST run itself again with the value, before its first asynchronous file call, when the variable is absent. On Windows the foreground server keeps the default pool, and the detached start gives the value.

The walk child of a search MUST NOT get the large pool. Its environment MUST hold no `UV_THREADPOOL_SIZE`, also when the person set one, thus it runs with the default pool. A large pool makes a walk about two times slower.

#### Scenario: A hung mount leaves threads for the other calls

- **GIVEN** a server-like process that started with the pool of the server, and at least 16 file opens that never return, 2 times the core count when that is more
- **WHEN** the process reads a folder
- **THEN** the read answers

#### Scenario: The detached child gets the pool

- **WHEN** `inflexa serve --detach` starts its child
- **THEN** the environment of the child holds `UV_THREADPOOL_SIZE` with the value of the server

#### Scenario: A value of the person stays

- **GIVEN** an environment that sets `UV_THREADPOOL_SIZE=8`
- **WHEN** the server starts
- **THEN** the pool size stays 8, and the foreground server does not run itself again

#### Scenario: The walk child keeps the default pool

- **GIVEN** a server whose environment holds `UV_THREADPOOL_SIZE`
- **WHEN** the server starts a walk child
- **THEN** the environment of the child holds no `UV_THREADPOOL_SIZE`
