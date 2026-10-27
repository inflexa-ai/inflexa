# Spec Delta

## ADDED Requirements

### Requirement: A child that the CLI starts for itself reads no update

The CLI MUST NOT start the update read in a process that the CLI started for itself. These children are the detached server, the `serve --detach` that a client starts for an `instance` command, the transfer children of the images and the catalog, the flush child of the store, and the walk child of a search. One predicate over the argument vector MUST name each of them, from the flags and the command words that the spawn sites use. A new hidden background child MUST join that predicate, not the start code. A command that the CLI starts in the terminal of the person, for example `inflexa up` from the TUI, is not such a child.

#### Scenario: The detached server reads no update

- **WHEN** the CLI starts with the arguments of the detached server child
- **THEN** it starts no update read

#### Scenario: A transfer child reads no update

- **WHEN** the CLI starts with the arguments of an image transfer child, or of the catalog transfer child
- **THEN** it starts no update read

#### Scenario: The flush child reads no update

- **WHEN** the CLI starts with the arguments of the flush child of the store
- **THEN** it starts no update read

#### Scenario: The walk child reads no update

- **WHEN** the CLI starts with `server walk <scope>`
- **THEN** it starts no update read

#### Scenario: The server start of a client reads no update

- **WHEN** an `instance` command starts the server with `serve --detach` and the client-start flag
- **THEN** that process starts no update read, and the person sees the notice of the command only

#### Scenario: A command of a person reads the update

- **WHEN** a person runs `inflexa ls`
- **THEN** the update read starts as before
