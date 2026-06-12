### Requirement: File-only structured logging
The system SHALL write all runtime logs as structured NDJSON via a single Pino root logger to a log file under the data directory (`<data>/inf/logs/`), creating the directory if missing. The logger SHALL NOT write to stdout or stderr, and SHALL NOT use worker-thread transports (`pino.transport`).

#### Scenario: Logs land in the log file
- **WHEN** any module logs through the logger while the TUI is running
- **THEN** the record is appended as one JSON line to the log file and nothing is written to the terminal

#### Scenario: First run creates the log directory
- **WHEN** the CLI starts on a machine where `<data>/inf/logs/` does not exist
- **THEN** the directory is created and logging proceeds without error

### Requirement: Module-scoped child loggers
The system SHALL expose a way to derive child loggers bound to a module name, and each record SHALL carry that module identifier.

#### Scenario: Child logger tags records
- **WHEN** a module obtains a child logger with name `db` and logs a record
- **THEN** the written record includes the `db` module identifier alongside the message

### Requirement: Log level from environment
The system SHALL read the log level from the `INF_LOG_LEVEL` environment variable, defaulting to `info` when unset or invalid.

#### Scenario: Default level
- **WHEN** the CLI starts with `INF_LOG_LEVEL` unset
- **THEN** `debug` records are suppressed and `info` and above are written

#### Scenario: Debug level enabled
- **WHEN** the CLI starts with `INF_LOG_LEVEL=debug`
- **THEN** `debug` records are written to the log file

### Requirement: PII redaction at the logger root
The system SHALL configure redaction on the root logger so that sensitive fields (message/part text, prompts, and other content-bearing fields) are replaced with `[REDACTED]` in every record. Redaction SHALL apply identically to all logger destinations, including any telemetry export stream.

#### Scenario: Content field is redacted
- **WHEN** a record is logged containing a configured sensitive field such as message text
- **THEN** the value stored in the log file is `[REDACTED]`

### Requirement: Bus events are logged
The system SHALL subscribe once to the event bus and log every `inf` event at `info` level, including the event type, `__infId`, and associated entity IDs, while excluding content fields (message text, part text, deltas).

#### Scenario: Event logged with IDs only
- **WHEN** a `part.delta` event is emitted on the bus
- **THEN** a record is written containing the event type, `__infId`, session/message/part IDs, and the delta length, but not the delta text

### Requirement: Log rotation and retention
The system SHALL write to a per-day log file (`inf-<YYYY-MM-DD>.log`) and SHALL enforce, at logger initialization: deletion of log files older than 7 days, and rolling to a numbered sibling file (`inf-<date>.<n>.log`) when the day's current file is at or above 20MB. Rotation failures SHALL NOT prevent logging.

#### Scenario: Old logs are deleted
- **WHEN** the CLI starts and the log directory contains a log file dated more than 7 days ago
- **THEN** that file is deleted and logging proceeds in today's file

#### Scenario: Oversized file rolls at startup
- **WHEN** the CLI starts and today's log file is 20MB or larger
- **THEN** new records are written to the next numbered file for today

### Requirement: Logs are flushed on exit
The system SHALL flush buffered log records as part of process shutdown so that records logged immediately before a normal exit are persisted.

#### Scenario: Tail records survive exit
- **WHEN** a record is logged and the user immediately quits the TUI
- **THEN** the record is present in the log file after the process exits
