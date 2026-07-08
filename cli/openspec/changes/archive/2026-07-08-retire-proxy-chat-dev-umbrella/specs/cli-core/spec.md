# cli-core — Delta

## MODIFIED Requirements

### Requirement: Commander registry with lazy-imported actions

The commands SHALL be registered on the commander root in `src/cli/index.ts`, each lazy-importing
its action (text commands from their module, chat-opening commands from `src/tui/app.launch.tsx`).
Dev-channel commands (`chat`, `profile`, `run` — see `dev-commands`) SHALL be registered only when
the dev channel is active, so a release build never carries them. Interactive confirms and pickers
SHALL use the shared clack-based prompts in `src/lib/cli.ts` (`confirm`, `select`, `promptText`),
declining gracefully on a non-interactive stdin — no bespoke `readline` picker.

#### Scenario: Actions are lazy-imported

- **WHEN** a command runs
- **THEN** only that command's action module is imported, keeping startup paths lean

#### Scenario: Non-interactive prompt declines

- **WHEN** a confirm/pick is reached with a non-interactive stdin
- **THEN** the prompt layer declines rather than hanging

#### Scenario: Dev commands register by channel

- **WHEN** the registry builds under the release channel without the runtime override
- **THEN** `chat`, `profile`, and `run` are not registered

## ADDED Requirements

### Requirement: inflexa sessions lists chat sessions

The system SHALL provide `inflexa sessions`, listing the saved chat sessions (id, title, creation
time) from the primary store. Sessions are the live launch-identity rows (threads bind 1:1 to
them); their `messages`/`parts` history is frozen legacy data with no remaining writer, and the
command performs reads only. The action lives in `src/modules/analysis/sessions.ts`.

#### Scenario: Sessions are listed read-only

- **WHEN** the user runs `inflexa sessions`
- **THEN** saved sessions print (or "No sessions found.") and no row is created or modified
