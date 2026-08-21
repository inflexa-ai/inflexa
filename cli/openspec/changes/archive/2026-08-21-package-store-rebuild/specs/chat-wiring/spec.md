# Delta: chat-wiring

## MODIFIED Requirements

### Requirement: Shared launch preamble

Every launcher that opens an analysis chat MUST share one factored
preamble. It holds the proxy-ready check (`ensureProxyReadyOrExit`), the
config validity gate, the theme seed, and the render options. All of it
runs in the normal-stdio phase, before `render()` takes over the terminal.
The interactive sandbox-image gate MUST NOT be part of the preamble: the app
renders at once, and the wait surfaces at the first sandbox-making action,
through the gate of the TUI. After `render()`, the launcher kicks off the
asynchronous harness runtime boot that drives the boot-state store (see
`tui-harness-chat`). The `App` component's props MUST be `workingDir` plus
`analysis`. The current thread id is workspace state resolved after boot
reaches `ready` (never a launcher prop), held reactively so the open chat
can be swapped in place.

#### Scenario: Launchers use the same preamble

- **WHEN** any launcher opens an analysis chat
- **THEN** the same proxy-ready handling, config gate, theme seeding, and render options run before the alternate screen, and the runtime boot starts after it

#### Scenario: The app opens during a transfer

- **GIVEN** a live image or catalog transfer
- **WHEN** the user opens the chat
- **THEN** the TUI renders at once, and only a sandbox-making action waits at the gate

#### Scenario: App carries no session prop

- **WHEN** `App` mounts
- **THEN** its props are `workingDir` plus `analysis`, and the current thread id is resolved into the reactive workspace state after boot reaches `ready`
