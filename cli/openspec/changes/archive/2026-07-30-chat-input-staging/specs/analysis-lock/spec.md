## ADDED Requirements

### Requirement: Input-mutating commands acquire the analysis lock

The single-writer discipline that keeps an analysis's provenance chain fork-free SHALL extend to standalone input mutation. The `inflexa inputs add` and `inflexa inputs remove` subcommands SHALL each acquire the target analysis's instance lock before mutating any input, and SHALL refuse — printing a message naming the analysis to stderr and exiting non-zero, mutating nothing — if a live instance already holds that lock. Adding or removing inputs from within an open chat SHALL rely on the lock that chat already holds and SHALL NOT acquire a second lock.

This preserves the existing invariant that only one process emits a given analysis's provenance at a time, now covering the input add/remove surfaces as it already covers open/switch and the `run`/`profile`/`chat` commands. The analysis-creation path is unaffected: it emits under a freshly-minted analysis id no other process can contend, so it needs no lock.

#### Scenario: A mutation subcommand acquires the lock for a free analysis

- **WHEN** `inflexa inputs add` or `inflexa inputs remove` runs for an analysis no live instance holds
- **THEN** it acquires that analysis's instance lock, applies the mutation, and releases the lock on exit

#### Scenario: A mutation subcommand refuses when the analysis is held elsewhere

- **GIVEN** an analysis open in a live chat instance (which holds its lock)
- **WHEN** `inflexa inputs add` or `inflexa inputs remove` targets that same analysis from another process
- **THEN** it prints that the analysis is open in another instance, exits non-zero, and mutates no input

#### Scenario: The in-process mutation takes no second lock

- **WHEN** inputs are added or removed from within the open chat (the agent tool or file picker)
- **THEN** no additional instance lock is acquired
- **AND** the mutation proceeds under the chat's existing lock
