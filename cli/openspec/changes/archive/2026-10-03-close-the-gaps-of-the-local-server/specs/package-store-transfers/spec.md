## MODIFIED Requirements

### Requirement: A sandbox-making action waits on the transfers with a notice

While a transfer runs, the app MUST stay open: the chat, the planner, and
the read surfaces work. In the TUI, a profile drive MUST wait while a
transfer is live, with one notice that names what it waits for. Then the
drive goes to the local server, which decides if a sandbox can start, per
`local-server`. A terminal transfer state that leaves the machine unable
to serve a sandbox MUST refuse the drive and name the retry command.
The hold and the server MUST NOT start a transfer, and they MUST NOT open
a consent.

#### Scenario: The chat works during the transfers

- **GIVEN** three live transfers after a fresh setup
- **WHEN** the user opens the TUI and chats
- **THEN** the conversation works, and only a sandbox-making action waits

#### Scenario: The gate starts nothing

- **GIVEN** a declined transfer state
- **WHEN** a sandbox-making action runs
- **THEN** the action refuses with the retry command, and no transfer starts

#### Scenario: A drive goes to the server when the transfers end

- **GIVEN** a profile drive of the TUI that waits for a live image transfer
- **WHEN** the transfer ends
- **THEN** the TUI sends the drive to the server, and it shows the outcome that the server gives
