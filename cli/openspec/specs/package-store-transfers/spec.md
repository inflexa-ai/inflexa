# package-store-transfers Specification

## Purpose

The detached transfer lifecycle that every multi-gigabyte download shares. Each transfer is a detached child with a database row, a per-kind lock for the liveness, and a TUI row.

## Requirements

### Requirement: Three transfer kinds share one detached lifecycle

The transfer kinds MUST be: the runtime image, the provisioner image, and
the catalog. Each transfer MUST run as one detached child process — a
re-invocation of the CLI with a hidden flag, with ignored stdio and
`unref`. Each transfer MUST own one database row with its state, its byte
totals, and its failure message. The lock family MUST give the liveness: a
`running` row with no live lock holder reads as `failed`. One transfer per
kind runs at a time. The command palette MUST offer the re-download of the
images and of the catalog, through the same transfer children.

#### Scenario: Three transfers run detached

- **WHEN** the setup starts the three transfers
- **THEN** three children run with their own rows, and the setup process exits without a wait

#### Scenario: A dead child reads as failed

- **GIVEN** a `running` row whose child process died
- **WHEN** the state is read
- **THEN** it reads as `failed`, with a retry command named

### Requirement: The TUI shows one live row per transfer until it completes

The setup screen and the sidebar MUST render one progress row per live
transfer: the kind, the state, and a transfer meter, read by poll. When a
transfer completes, its row MUST disappear. No "ready" line stays behind,
because a completed state that everyone has is noise. A terminal failure
row MUST stay visible, with a short hint. A key push on the row MUST retry
the transfer, and a command palette entry MUST give the same retry.

#### Scenario: The rows disappear on completion

- **GIVEN** three transfers that complete
- **WHEN** the sidebar renders again
- **THEN** no transfer row and no "ready" line shows

#### Scenario: A failure stays visible

- **GIVEN** a catalog transfer that failed
- **WHEN** the sidebar renders
- **THEN** the row shows the failure and names `inflexa store download` as the retry

### Requirement: An image replaces its predecessor only after the pull verifies

A re-download of an image MUST keep the present image until the new pull
verifies. Only then MUST the superseded image be removed, and the TUI MUST
say that it was. A failed pull leaves the present image untouched.

#### Scenario: The old image survives a failed pull

- **GIVEN** a present runtime image and a pull that fails
- **WHEN** the transfer ends
- **THEN** the present image still serves, and nothing was removed

#### Scenario: The replacement is announced

- **GIVEN** a verified new image
- **WHEN** the superseded image is removed
- **THEN** the TUI reports the removal

### Requirement: A sandbox-making action waits on the transfers with a notice

While a transfer runs, the app MUST stay open: the chat, the planner, and
the read surfaces work. Only a sandbox-making action waits, with a notice
that names what it waits for. A terminal transfer state MUST refuse the
action and name the retry command. The gate MUST NOT start a transfer and
MUST NOT open a consent.

#### Scenario: The chat works during the transfers

- **GIVEN** three live transfers after a fresh setup
- **WHEN** the user opens the TUI and chats
- **THEN** the conversation works, and only a sandbox-making action waits

#### Scenario: The gate starts nothing

- **GIVEN** a declined transfer state
- **WHEN** a sandbox-making action runs
- **THEN** the action refuses with the retry command, and no transfer starts
