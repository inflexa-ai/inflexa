## MODIFIED Requirements

### Requirement: Shared launch preamble

Every launcher that opens an analysis chat SHALL share one factored preamble: the proxy-ready check
(`ensureProxyReadyOrExit`), the harness config validity gate, the theme seed, and the render options,
all running in the normal-stdio phase before `render()` takes over the terminal.
The interactive sandbox-image ensure SHALL NOT run in the preamble: the image wait and the store wait
belong to the sandbox gate (see `lib-store-download`), at the first action that makes a sandbox.
After `render()`, the launcher SHALL kick off the asynchronous harness runtime boot that drives the
boot-state store (see `tui-harness-chat`). The `App` component's props SHALL be
`workingDir` + `analysis`; the current thread id is workspace state resolved after boot reaches
`ready` (never a launcher prop), held reactively so the open chat can be swapped in place.

#### Scenario: Launchers use the same preamble

- **WHEN** any launcher opens an analysis chat
- **THEN** the same proxy-ready handling, config gate, theme seeding, and render options run before the alternate screen, and the runtime boot starts after it

#### Scenario: The sandbox-image wait stays out of the preamble

- **WHEN** the sandbox image is missing, or the store download is not complete
- **THEN** the app renders at once, and the wait surfaces inside the TUI at the first sandbox action

#### Scenario: App carries no session prop

- **WHEN** `App` mounts
- **THEN** its props are `workingDir` + `analysis`, and the current thread id is resolved into the reactive workspace state after boot reaches `ready`
