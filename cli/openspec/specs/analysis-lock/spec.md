# analysis-lock Specification

## Purpose
The per-analysis advisory instance lock (`src/lib/lock.ts`): a pid-liveness-based lock file, keyed by analysis id, that keeps an analysis single-process: the local server takes it at the first request for an analysis and holds it until it exits, and the dev `run --plan`, which boots its own runtime, holds it for its run. Thus only one process emits an analysis's provenance at a time (the interim two-recorder fix of #37). Written only on deliberate actions (never a passive flow), reclaimed by pid liveness, and released ownership-checked on exit.

## Requirements

### Requirement: The local server holds the analysis lock

The local server SHALL acquire the per-analysis advisory lock at the first request under the path prefix of the analysis (`/api/v1/analyses/:analysisId`), after it confirms that the analysis exists, and SHALL hold it until its process exits. Each request under that prefix passes the same check, a read as well as a write, and a request of an analysis whose lock the server already holds acquires nothing new. If a different live process holds the lock, the server SHALL refuse the request with 409 `locked`, with a message that names the analysis and with the holder pid in the details, and SHALL run no handler. The lock SHALL be keyed by analysis id (not session id), since one analysis owns many sessions.

Each client of one server shares the hold of that server: two TUIs, or a TUI and an instance command, that use one server can open the same analysis. The lock keeps one provenance recorder on each signed chain across processes, thus it fences a process that writes the chain of the analysis directly, for example `inflexa run --plan`.

A client that opens an analysis for chat SHALL read the analysis through the server before the terminal alternate screen is entered. A refusal SHALL print the message of the server to stderr and exit with a non-zero status without entering the TUI.

The lock SHALL be written only by a request that names the analysis. A launch path that resolves to no analysis (for example bare `inflexa` that prompts and is canceled, or a folder-copy result) sends no such request and SHALL NOT write any lock file. The resolve of a folder, the list of analyses, and the creation of an analysis SHALL NOT take a lock.

#### Scenario: Opening a free analysis acquires the lock

- **WHEN** a user opens an analysis that no different live process holds
- **THEN** the local server acquires the lock keyed by that analysis id at the read of the analysis
- **AND** the client proceeds to render the chat TUI

#### Scenario: Opening an analysis already live elsewhere is refused

- **WHEN** a user opens an analysis whose lock a different live process holds
- **THEN** the server answers 409 `locked`, and the client prints "<analysis name> is already open in another instance" to stderr
- **AND** the client exits with a non-zero status before the alternate screen is entered

#### Scenario: Two clients of one server open the same analysis

- **GIVEN** a TUI that has the analysis open through the local server
- **WHEN** a second TUI opens the same analysis through the same server
- **THEN** the server serves both, and no lock conflict occurs

#### Scenario: No lock written when launch resolves to nothing

- **WHEN** a launch flow resolves to no analysis (canceled prompt or folder-copy outcome)
- **THEN** no lock file is created

### Requirement: Pid-liveness reclaim of dead holders

A lock SHALL record the holding process's pid. When acquiring a lock whose file already exists, the system SHALL determine liveness by probing the recorded pid (`process.kill(pid, 0)`). The system SHALL reclaim the lock only if the holder is dead (probe throws `ESRCH`); a lock held by a live pid SHALL block acquisition. The system SHALL NOT use elapsed-time staleness to free a lock, because a holder keeps an analysis lock for the whole life of its process, and the local server lives for days.

#### Scenario: A lock held by a dead pid is reclaimed

- **WHEN** the system attempts to acquire a lock whose recorded pid no longer exists
- **THEN** the system reclaims the lock and proceeds as if it were free

#### Scenario: A lock held by a live pid blocks acquisition

- **WHEN** the system attempts to acquire a lock whose recorded pid is still alive
- **THEN** acquisition fails and the open/switch is treated as a conflict

### Requirement: Lock release on exit

The system SHALL release each held analysis lock on process exit, the graceful stop of the local server included. The local server SHALL also release the lock of an analysis when it deletes that analysis, because no later request can name it. A client that quits SHALL release nothing, because it holds no analysis lock. Release SHALL be ownership-checked: the system SHALL only delete a lock file it still owns (recorded pid matches the current process), so it never deletes a lock another instance has reclaimed. A hard kill that bypasses all exit hooks MAY leave a stale lock file behind; such a file SHALL be reclaimable on the next acquire via the pid-liveness check.

#### Scenario: Graceful quit releases the held lock

- **WHEN** the local server stops gracefully (`inflexa server stop`, or Ctrl+C in its terminal)
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

### Requirement: A command that boots its own runtime holds the analysis lock

The dev `inflexa run --plan` boots a runtime in its own process and writes the provenance of its run there. It SHALL acquire the per-analysis instance lock after the analysis is resolved and before the runtime boots or any state is mutated. A conflict SHALL print a message naming the analysis and the fact that another instance holds it, and exit non-zero without booting. The lock SHALL be released through the exit hook of the process, and the pid-liveness reclaim and ownership-checked release requirements apply unchanged to this holder.

A command that is a client of the local server (`inflexa profile`, `inflexa chat`, `inflexa run --status`) SHALL take no analysis lock in its own process. The local server holds the lock for each request that such a command sends.

#### Scenario: A command on a free analysis proceeds

- **WHEN** `inflexa run --plan` targets an analysis that no live process holds
- **THEN** the lock is acquired under the analysis id and the command proceeds to boot

#### Scenario: A command on a held analysis is refused

- **WHEN** `inflexa run --plan` targets an analysis whose lock the local server or a different command holds
- **THEN** it prints the conflict to stderr and exits non-zero before booting the runtime

#### Scenario: Command exit releases the lock

- **WHEN** `inflexa run --plan` finishes (success, failure, or detach)
- **THEN** the lock is released through the exit hook and a subsequent process can acquire it

#### Scenario: A client command takes no lock

- **WHEN** `inflexa profile` or `inflexa chat` runs against an analysis
- **THEN** its own process writes no lock file, and the local server holds the lock of the analysis

### Requirement: An analysis switch reads the target through the local server first

When the open analysis changes within a running TUI (Switch-analysis in the command palette, or any other in-process swap through the single `openSession` write path), the TUI SHALL read the target analysis through the local server before it swaps, and the server takes the lock of the target at that read. If the server refuses the read (a different live process holds the lock, or no server answers), the TUI SHALL keep the current analysis open, SHALL NOT do the swap, and SHALL surface a warning notice with the reason.

The swap SHALL release no lock: the server keeps the lock of each analysis that it served until its process exits. Creating a brand-new analysis SHALL never conflict, because it mints a fresh analysis id.

#### Scenario: Switching to a free analysis

- **WHEN** the user switches to an analysis that no different live process holds
- **THEN** the server takes the lock of the target at the read, and the TUI completes the swap
- **AND** the server keeps the lock of the previous analysis

#### Scenario: Switching to an analysis that a different process holds is refused in place

- **WHEN** the user switches to an analysis whose lock a different live process holds
- **THEN** the TUI keeps the current analysis open
- **AND** surfaces a warning notice naming the conflicting analysis
- **AND** does not do the swap

#### Scenario: Creating a new analysis never conflicts

- **WHEN** the user creates a new analysis from within a running TUI
- **THEN** the lock of the new analysis is always free because the analysis id is freshly minted

### Requirement: Input changes run under the lock of the local server

The single-writer discipline that keeps an analysis's provenance chain fork-free SHALL extend to each input change. The `inflexa inputs add` and `inflexa inputs remove` subcommands, and the input changes of the TUI, are clients of the local server: their requests pass the analysis check of the server, which holds the lock of the analysis before any input changes. If a different live process holds that lock, the server SHALL refuse with 409 `locked` and SHALL change no input, and the subcommand SHALL print the message and exit non-zero. The process of the subcommand SHALL acquire no lock.

The input tool of the conversation agent runs inside a chat turn in the server process. It SHALL refuse a change when that process does not hold the lock of the analysis, as a defense in depth: the chat route already passed the analysis check.

This preserves the existing invariant that only one process emits a given analysis's provenance at a time. The analysis-creation path is unaffected: it emits under a freshly-minted analysis id no other process can contend, so it needs no lock.

#### Scenario: A subcommand changes the inputs of a free analysis

- **WHEN** `inflexa inputs add` or `inflexa inputs remove` runs for an analysis that no different live process holds
- **THEN** the server takes the lock of the analysis and applies the change, and the subcommand writes no lock file

#### Scenario: A subcommand is refused when a different process holds the analysis

- **GIVEN** an analysis whose lock a different live process holds, for example `inflexa run --plan`
- **WHEN** `inflexa inputs add` or `inflexa inputs remove` targets that analysis through the local server
- **THEN** the server answers 409 `locked`, the subcommand prints that the analysis is open in another instance and exits non-zero, and no input changes

#### Scenario: The agent tool changes inputs under the lock of the server

- **WHEN** the agent adds or removes inputs inside a chat turn
- **THEN** the change runs in the server process, which holds the lock of the analysis, and no additional lock is acquired
