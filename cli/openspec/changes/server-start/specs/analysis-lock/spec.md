## MODIFIED Requirements

### Requirement: Lock release on exit

The system SHALL release each held analysis lock on process exit, the graceful stop of the local server included. The local server SHALL also release the lock of an analysis when it deletes that analysis, because no later request can name it. A client that quits SHALL release nothing, because it holds no analysis lock. Release SHALL be ownership-checked: the system SHALL only delete a lock file it still owns (recorded pid matches the current process), so it never deletes a lock another instance has reclaimed. A hard kill that bypasses all exit hooks MAY leave a stale lock file behind; such a file SHALL be reclaimable on the next acquire via the pid-liveness check.

#### Scenario: Graceful quit releases the held lock

- **WHEN** the local server stops gracefully (`inflexa server stop`, or SIGINT or SIGTERM)
- **THEN** each analysis lock that it held is released

#### Scenario: Process exit releases the held lock

- **WHEN** the process exits through the exit hook
- **THEN** the held analysis lock is removed synchronously

#### Scenario: A quit of the chat releases nothing

- **WHEN** the user quits the chat normally
- **THEN** the TUI releases no lock, and the server keeps the lock of the analysis

#### Scenario: A delete releases the lock of the deleted analysis

- **WHEN** the local server deletes an analysis
- **THEN** it releases the lock of that analysis at the end of the delete

#### Scenario: Ownership-checked release spares a reclaimed lock

- **WHEN** the process releases its lock but the lock file's recorded pid is no longer this process
- **THEN** the system leaves the file untouched

#### Scenario: A hard-killed instance's lock is reclaimed later

- **WHEN** an instance is killed without running its exit hooks, leaving a lock file
- **THEN** the next acquire finds the recorded pid dead and reclaims the lock
