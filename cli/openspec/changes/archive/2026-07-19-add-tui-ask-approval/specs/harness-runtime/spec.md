## ADDED Requirements

### Requirement: The composition root realizes the tool-approval gateway

The embedded-runtime boot SHALL construct the harness ask gateway from the app
pool at the composition root, expose it on the runtime handle so surfaces can
answer and enumerate asks, and run the gateway's expiry sweep in the boot
chores that execute after the harness has initialized its state tables — so
pending asks orphaned by a prior process are expired before any new turn runs.

#### Scenario: The runtime handle carries the gateway

- **GIVEN** a booted harness runtime
- **WHEN** a TUI surface needs to answer an ask
- **THEN** the gateway is reachable from the runtime handle without constructing a second realization

#### Scenario: Orphaned asks are swept at boot

- **GIVEN** a prior process that died with a pending ask in the ledger
- **WHEN** the runtime boots
- **THEN** the sweep marks it expired before the first turn can run
