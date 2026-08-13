## Why

An analysis conversation can now spawn a report session as a child thread. The harness holds the parent link, the thread type, and the anchor. The CLI holds none of it. A user who starts a report session has no way to reach it again, and no way to return to the analysis that made it.

The switch picker also lists every live thread of the analysis with no type filter. Thus a report child appears among the conversations, with no mark that says what it is.

## What Changes

- A remappable keybind pair moves between a conversation and its report children. The defaults are `<leader> left` and `<leader> right`, because macOS consumes a ctrl-arrow for its own window control.
- A palette command lists the report children of the open conversation, and it opens the one that the user picks. It reads the same population as the forward keybind, thus the two surfaces cannot disagree.
- The switch picker narrows to conversations. Thus each picker has one population, and neither list mixes two kinds of thread. The two pickers are one component over two sets of data.
- The chat shows an entry point into each report child of the open conversation, at the point of the transcript where that child was spawned.

## Capabilities

### New Capabilities

- `report-session-navigation`: how a user moves between an analysis conversation and its report sessions. It covers the keybind pair, the report picker, the chat entry point, and the notice that each dead direction gives.

### Modified Capabilities

- `command-palette`: the Switch session picker narrows its listing to the `conversation` thread type. Today it lists every live thread, thus it mixes a report child into the conversations.
- `tui-harness-chat`: the thread that the launch resolves narrows to the `conversation` thread type. Today the launch reads every live thread, thus a fresh report child is the thread that the next launch opens.

## Impact

- `src/tui/keymap.ts` — two ids in the remappable defaults.
- `src/tui/commands.tsx` — the report picker, the narrowed switch listing, and the two navigation flows.
- `src/tui/app.tsx` — the two leader chords.
- `src/tui/hooks/thread.ts` — the narrowed read of the launch.
- `src/tui/hooks/conversation.ts` — the report children of the open conversation, and the anchor of each loaded message.
- `src/tui/layout/message_block.tsx` and `src/tui/components/` — the entry widget in the transcript.

## A note on what a user sees today

The CLI composes no browser, thus the harness refuses every spawn with `no_browser`. No report thread is written at all until a browser realization lands. These surfaces are correct and covered, and they list nothing until then. The absence blocks no work here, because a test seeds a report thread in Postgres directly.
