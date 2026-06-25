# analysis-lock Specification

## Purpose
TBD - created by archiving change add-analysis-instance-lock. Update Purpose after archive.
## Requirements
### Requirement: Single-instance analysis lock at launch

The system SHALL acquire a per-analysis advisory lock when an analysis is opened for chat, before the terminal alternate screen is entered. If the analysis is already held by a live instance, the system SHALL refuse to open it, print a message naming the analysis to stderr, and exit with a non-zero status without entering the TUI. The lock SHALL be keyed by analysis id (not session id), since one analysis owns many sessions.

The lock SHALL be written only as part of the deliberate open action; a launch path that resolves to no analysis (e.g. bare `inf` that prompts and is cancelled, or a folder-copy result) SHALL NOT write any lock file.

#### Scenario: Opening a free analysis acquires the lock

- **WHEN** a user opens an analysis that no live instance holds
- **THEN** the system acquires the lock keyed by that analysis id
- **AND** proceeds to render the chat TUI

#### Scenario: Opening an analysis already live elsewhere is refused

- **WHEN** a user opens an analysis already held by another live instance
- **THEN** the system prints "<analysis name> is already open in another instance" to stderr
- **AND** exits with a non-zero status before the alternate screen is entered

#### Scenario: No lock written when launch resolves to nothing

- **WHEN** a launch flow resolves to no analysis (cancelled prompt or folder-copy outcome)
- **THEN** no lock file is created

### Requirement: Re-key the lock on in-process analysis switch

When the open analysis changes within a running instance (Switch-analysis in the command palette, or any other in-process swap through the single `openSession` write path), the system SHALL re-key the lock by acquiring the target analysis's lock BEFORE releasing the current one. If the target is already held by a live instance, the system SHALL keep the current analysis open, SHALL NOT release the current lock, SHALL NOT perform the swap, and SHALL surface a warning notice to the user. Creating a brand-new analysis SHALL never conflict, because it mints a fresh analysis id.

#### Scenario: Switching to a free analysis re-keys the lock

- **WHEN** the user switches to an analysis no live instance holds
- **THEN** the system acquires the target's lock, then releases the previous analysis's lock
- **AND** completes the swap

#### Scenario: Switching to an analysis live elsewhere is refused in-place

- **WHEN** the user switches to an analysis already held by another live instance
- **THEN** the system keeps the current analysis open and retains its lock
- **AND** surfaces a warning notice naming the conflicting analysis
- **AND** does not perform the swap

#### Scenario: Creating a new analysis never conflicts

- **WHEN** the user creates a new analysis from within a running instance
- **THEN** acquiring its lock always succeeds because the analysis id is freshly minted

### Requirement: Pid-liveness reclaim of dead holders

A lock SHALL record the holding process's pid. When acquiring a lock whose file already exists, the system SHALL determine liveness by probing the recorded pid (`process.kill(pid, 0)`). The system SHALL reclaim the lock only if the holder is dead (probe throws `ESRCH`); a lock held by a live pid SHALL block acquisition. The system SHALL NOT use elapsed-time staleness to free a lock, because an analysis lock is held for an entire interactive session.

#### Scenario: A lock held by a dead pid is reclaimed

- **WHEN** the system attempts to acquire a lock whose recorded pid no longer exists
- **THEN** the system reclaims the lock and proceeds as if it were free

#### Scenario: A lock held by a live pid blocks acquisition

- **WHEN** the system attempts to acquire a lock whose recorded pid is still alive
- **THEN** acquisition fails and the open/switch is treated as a conflict

### Requirement: Lock release on exit

The system SHALL release a held analysis lock on graceful quit and on process exit. Release SHALL be ownership-checked: the system SHALL only delete a lock file it still owns (recorded pid matches the current process), so it never deletes a lock another instance has reclaimed. A hard kill that bypasses all exit hooks MAY leave a stale lock file behind; such a file SHALL be reclaimable on the next acquire via the pid-liveness check.

#### Scenario: Graceful quit releases the held lock

- **WHEN** the user quits the chat normally
- **THEN** the held analysis lock is released

#### Scenario: Process exit releases the held lock

- **WHEN** the process exits through the exit hook
- **THEN** the held analysis lock is removed synchronously

#### Scenario: Ownership-checked release spares a reclaimed lock

- **WHEN** the process releases its lock but the lock file's recorded pid is no longer this process
- **THEN** the system leaves the file untouched

#### Scenario: A hard-killed instance's lock is reclaimed later

- **WHEN** an instance is killed without running its exit hooks, leaving a lock file
- **THEN** the next acquire finds the recorded pid dead and reclaims the lock

