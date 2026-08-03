## Why

An analysis can hold many conversation threads, and every thread surface exists in the TUI — switch, rename, remove, restore, erase — except the one that starts a fresh conversation. Today a user can only get a new session implicitly (first open of an analysis with no threads, or the dev REPL's new-by-default). The product has no deliberate "start a new conversation" action.

## What Changes

- Add a **New session** command (`session.new`, category Session) to the palette: it mints a fresh thread id and swaps the open chat onto it in place via `ctx.openSession`. No row is written — the first turn creates the thread row (`prepareChatTurn`), typed `conversation` by the harness default, with its title seeded from the message.
- Add a **pinned escape-hatch row** ("Start a new session") to the Switch session picker, so the place users go to think about sessions also offers creation — including when the picker is otherwise empty.
- The command is boot-gated like its Session siblings (`analysis` open and boot `ready`): a pre-`ready` chat cannot send a turn, so offering the command earlier would promise a surface that cannot act.
- Deliberately **conversation-only by construction**: the path never passes a thread type, and the harness defaults an absent thread to `conversation`. Report sessions (issue #221/#225) are created explicitly by the harness with a type and parent — this command cannot produce one and needs no change when they land.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `command-palette`: the "In-place session-switching commands" requirement gains the New session command (mint + in-place swap, no row until the first turn) and the pinned creation row in the Switch session picker.

## Impact

- `cli/src/tui/commands.tsx` — the new command entry + the pinned row in `openSwitchSession`; tests in `cli/src/tui/commands.test.ts`.
- No harness change, no schema change, no new persistence: the mint-then-first-turn-creates-row mechanism already exists (`hooks/thread.ts`, harness `app/chat-turn.ts`), and the sidebar already renders the fresh-mint `absent` state.
- No collision with the active `analysis-purge-and-session-restore` change (restore/purge flows; this change touches neither).
