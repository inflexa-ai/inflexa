## ADDED Requirements

### Requirement: Opt-in consent stored in user config
Telemetry SHALL be disabled by default. Consent SHALL be persisted as `{ "telemetry": boolean }` in a JSON config file under the user config directory (`XDG_CONFIG_HOME`/`~/.config` on Unix, `APPDATA` on Windows, path `inf/config.json`). A missing or unreadable config file SHALL be treated as consent not granted.

#### Scenario: Default is off
- **WHEN** the CLI runs on a machine with no config file
- **THEN** no telemetry is initialized and no network calls are made

#### Scenario: Corrupt config fails closed
- **WHEN** the config file exists but contains invalid JSON
- **THEN** telemetry is treated as disabled and the CLI runs normally

### Requirement: Interactive settings command
The system SHALL provide an `inf config` command that opens an interactive OpenTUI settings form built only from existing dependencies. The form SHALL show one checkbox row per setting; the telemetry row SHALL display a short disclosure of what is collected and whether an export endpoint is configured. Toggling a setting SHALL only update an in-form draft (marked as unsaved); pressing `s` or Ctrl+S SHALL persist the draft to the config file. Exiting with unsaved changes SHALL warn once and require a second exit press to discard. Exiting the form SHALL restore the terminal state (mouse tracking, alternate screen, input mode) before going through the flushing shutdown path.

#### Scenario: Terminal is restored on exit
- **WHEN** the user exits the form
- **THEN** every terminal mode the form enabled (mouse tracking, alternate screen, bracketed paste) is reset and the shell behaves normally afterwards

#### Scenario: Viewing settings
- **WHEN** the user runs `inf config`
- **THEN** a form shows the telemetry checkbox with its persisted state, the collection disclosure, and the endpoint configuration

#### Scenario: Toggling only changes the draft
- **WHEN** the user toggles the telemetry row without saving
- **THEN** the row is marked as changed and the config file is untouched

#### Scenario: Saving persists the draft
- **WHEN** the user toggles the telemetry row and presses `s`
- **THEN** the config file records the new value and the form confirms the save

#### Scenario: Quitting with unsaved changes
- **WHEN** the user presses q/Esc with unsaved changes
- **THEN** the form warns and stays open; a second q/Esc discards the draft and exits with the config file untouched

#### Scenario: Persisting failure is surfaced
- **WHEN** a save cannot be written to the config file
- **THEN** the form shows an error and the persisted state is unchanged

### Requirement: Explicit OTel initialization gated on consent and endpoint
The system SHALL initialize the OpenTelemetry Logs SDK via an explicit, idempotent `initOtel()` call from the entry point, only when consent is granted AND `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The SDK SHALL use a resource with `service.name` `inf` and the package version, and SHALL export via a batch log record processor to `<endpoint>/v1/logs` (trailing slashes stripped) over OTLP/HTTP.

#### Scenario: Consent without endpoint
- **WHEN** consent is granted but `OTEL_EXPORTER_OTLP_ENDPOINT` is unset
- **THEN** no exporter is created and logging to file continues unaffected

#### Scenario: Consent and endpoint present
- **WHEN** consent is granted and the endpoint is set
- **THEN** log records are exported in batches to `<endpoint>/v1/logs` with the `inf` service resource

#### Scenario: Repeated initialization
- **WHEN** `initOtel()` is called more than once in a process
- **THEN** only the first call has effect

### Requirement: Pino records bridge to OTel log records
When telemetry is active, the system SHALL forward each Pino record to the OTel Logs API through an in-process bridge stream (no worker threads, no module patching), mapping Pino levels to OTel severities (10→TRACE, 20→DEBUG, 30→INFO, 40→WARN, 50→ERROR, 60→FATAL), using the Pino `msg` as the log body, and carrying remaining fields as attributes. Records SHALL reach the bridge after redaction has been applied.

#### Scenario: Level mapping
- **WHEN** a Pino record with level 50 is logged while telemetry is active
- **THEN** the exported OTel log record has ERROR severity

#### Scenario: Redaction precedes export
- **WHEN** a record containing a sensitive field is logged while telemetry is active
- **THEN** the exported record contains `[REDACTED]` for that field

### Requirement: Telemetry fails open
Telemetry SHALL never crash, block, or visibly degrade the CLI. Export failures (unreachable endpoint, network errors, exporter errors) SHALL be swallowed and at most logged to the local file at `debug` level.

#### Scenario: Endpoint unreachable
- **WHEN** telemetry is active but the endpoint refuses connections
- **THEN** the TUI runs normally and the failure is at most a debug record in the local log file

### Requirement: Telemetry flushes on shutdown
The system SHALL provide a `shutdownOtel()` that force-flushes pending batches with a bounded timeout, never throws, and is invoked on the CLI's normal exit paths.

#### Scenario: Final batch is exported
- **WHEN** records are logged and the process exits normally moments later
- **THEN** those records are exported before exit (within the shutdown timeout) rather than dropped

#### Scenario: Shutdown with failing exporter
- **WHEN** `shutdownOtel()` runs while the endpoint is unreachable
- **THEN** shutdown completes within the timeout and the process exits cleanly
