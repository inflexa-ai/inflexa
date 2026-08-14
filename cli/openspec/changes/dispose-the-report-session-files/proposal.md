## Why

"Delete session" erases a thread and every message under it. It touches no file. A report session owns a page directory on disk, and that directory stays after the erase. Its name is a thread id that no longer exists. Thus no surface can name it again, and the user cannot tell which directory belonged to what.

The erase reaches the whole subtree. Thus one delete of a conversation orphans the directory of every report session under it. Each one holds its own copy of the chart runtime.

The analysis delete already asks this question. It offers to archive or to delete the workspace tree before it removes the row. The session verbs never asked, because until the report sessions they owned no files.

## What Changes

- The delete flow asks whether to remove the page files of each erased report session. It asks on every delete, because the set of erased threads arrives after the answer.
- The removal runs after the erase succeeds. A refused or failed erase leaves each file alone.
- The flow names each directory through the harness. It composes no layout of its own.
- The remove flow and the restore flow do not change. A tombstone keeps the row, thus its page still stands and the user can come back to it.

## Capabilities

### Modified Capabilities

- `command-palette`: the delete-session command gains the file question and the disposal that answers it.

## Impact

- `src/tui/commands.tsx` — `purgeSessionFlow` and `confirmSessionPurge`, plus the `SessionSeams` entries that the two want.
- The harness gives back the erased thread ids and the directory helper. This work consumes both.
- No new dependency, and no change to the remove verb or to the restore verb.
