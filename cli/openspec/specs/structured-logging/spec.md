# structured-logging Specification

## Purpose
File-only structured NDJSON logging via a single Pino root logger — module-scoped child loggers, env-driven level, PII redaction, bus-event logging, daily rotation/retention, and flush-on-exit.

## Requirements

### Requirement: File-only structured logging
The system SHALL write all runtime logs as structured NDJSON via a single Pino root logger to a log file under the data directory (`<data>/inflexa/logs/`), creating the directory if missing. The logger SHALL NOT write to stdout or stderr, and SHALL NOT use worker-thread transports (`pino.transport`).

#### Scenario: Logs land in the log file
- **WHEN** any module logs through the logger while the TUI is running
- **THEN** the record is appended as one JSON line to the log file and nothing is written to the terminal

#### Scenario: First run creates the log directory
- **WHEN** the CLI starts on a machine where `<data>/inflexa/logs/` does not exist
- **THEN** the directory is created and logging proceeds without error

### Requirement: Module-scoped child loggers
The system SHALL expose a way to derive child loggers bound to a module name, and each record SHALL carry that module identifier.

#### Scenario: Child logger tags records
- **WHEN** a module obtains a child logger with name `db` and logs a record
- **THEN** the written record includes the `db` module identifier alongside the message

### Requirement: Log level from environment
The system SHALL read the log level from the `INFLEXA_LOG_LEVEL` environment variable, defaulting to `info` when unset or invalid.

#### Scenario: Default level
- **WHEN** the CLI starts with `INFLEXA_LOG_LEVEL` unset
- **THEN** `debug` records are suppressed and `info` and above are written

#### Scenario: Debug level enabled
- **WHEN** the CLI starts with `INFLEXA_LOG_LEVEL=debug`
- **THEN** `debug` records are written to the log file

### Requirement: PII redaction at the logger root
The system SHALL configure redaction on the root logger so that sensitive fields (message/part text, prompts, and other content-bearing fields) are replaced with `[REDACTED]` in every record. Redaction SHALL apply identically to all logger destinations, including any telemetry export stream.

#### Scenario: Content field is redacted
- **WHEN** a record is logged containing a configured sensitive field such as message text
- **THEN** the value stored in the log file is `[REDACTED]`

### Requirement: Bus events are logged
The system SHALL subscribe once to the event bus and log every `inflexa` event at `info` level, including the event type, `__infId`, and associated entity IDs, while excluding content fields (message text, part text, deltas).

#### Scenario: Event logged with IDs only
- **WHEN** a `part.delta` event is emitted on the bus
- **THEN** a record is written containing the event type, `__infId`, session/message/part IDs, and the delta length, but not the delta text

### Requirement: Log rotation and retention
The system MUST write to a per-day log file named `inflexa-<YYYY-MM-DD>.log`, where the date is the local calendar date of the machine. The retention sweep and the size scan run at logger initialization and at each midnight roll. The sweep MUST delete each log file whose date is more than 7 days old on the same local calendar. The scan MUST roll to a numbered sibling file (`inflexa-<date>.<n>.log`) when the file of the day is at or above 20MB. While the process lives, the system MUST move to the file of the new day at local midnight: a timer fires at the next local midnight, the destination reopens on the new name, and the timer arms again. The roll MUST flush the buffered records into the old file before the reopen. The roll MUST NOT add work to the write path, and it MUST NOT keep the process alive. A rotation failure MUST NOT prevent logging.

#### Scenario: The file name carries the local date
- **WHEN** the CLI starts at 01:00 local on a machine at UTC+03:00
- **THEN** the records go to the file named for the local date, not for the UTC date of the day before

#### Scenario: A live session moves to the new day at midnight
- **WHEN** a session logs at 23:59 local and then at 00:01 local
- **THEN** the record at 23:59 is in the file of the first day. The record at 00:01 is in the file of the second day

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
