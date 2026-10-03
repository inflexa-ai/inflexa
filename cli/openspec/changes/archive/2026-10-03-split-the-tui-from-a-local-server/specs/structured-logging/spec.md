# structured-logging Delta

## ADDED Requirements

### Requirement: The server log is apart from the structured log

The structured log SHALL stay the only destination of the Pino root logger, in each process: a client, the TUI, and the local server. The terminal output of a local server that runs in the background (its stdout and stderr) SHALL go to a separate plain-text server log in the same log directory, one file for each build channel. The retention sweep and the size roll of the structured log SHALL NOT match, roll, or delete the server log, and the server log SHALL NOT receive Pino records. The server log keeps its own size bound, which the local server owns.

#### Scenario: A background server writes its output to the server log

- **WHEN** a local server that runs in the background prints a line to its stdout or stderr
- **THEN** the line is appended to the server log, and no line reaches a terminal

#### Scenario: The retention sweep spares the server log

- **GIVEN** a server log that the local server wrote more than 7 days ago
- **WHEN** the logger initializes and runs its retention sweep
- **THEN** the server log stays, because its name does not match the dated name of the structured log

#### Scenario: Module records stay in the structured log

- **WHEN** a module of the local server logs through the logger
- **THEN** the record is appended as one JSON line to the structured log file of the day, not to the server log
