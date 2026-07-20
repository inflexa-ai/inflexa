## MODIFIED Requirements

### Requirement: Commander registry with lazy-imported actions

The commands SHALL be registered by a reusable `buildProgram()` factory in `src/cli/index.ts` that returns a fresh commander root, each command lazy-importing its action (text commands from their module, chat-opening commands from `src/tui/app.launch.tsx`). The release entry point (`src/index.ts`) SHALL obtain its program from this factory, so there is one registration and one binary; the factory being callable more than once is what lets a second instance be built for dry classification (see `agent-cli-tool`). Dev-channel commands (`chat`, `profile`, `run` — see `dev-commands`) SHALL be registered only when the dev channel is active, so a release build never carries them. Interactive confirms and pickers SHALL use the shared clack-based prompts in `src/lib/cli.ts` (`confirm`, `select`, `promptText`), declining gracefully on a non-interactive stdin — no bespoke `readline` picker.

#### Scenario: Actions are lazy-imported

- **WHEN** a command runs
- **THEN** only that command's action module is imported, keeping startup paths lean

#### Scenario: The factory builds an independent program each call

- **WHEN** `buildProgram()` is called more than once in a process
- **THEN** each call returns a fresh commander root with the same command tree, so one instance can be built for real dispatch and another for classification without shared parse state

#### Scenario: Non-interactive prompt declines

- **WHEN** a confirm/pick is reached with a non-interactive stdin
- **THEN** the prompt layer declines rather than hanging

#### Scenario: Dev commands register by channel

- **WHEN** the registry builds under the release channel without the runtime override
- **THEN** `chat`, `profile`, and `run` are not registered
