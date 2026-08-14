## Context

`purgeSessionFlow` (`tui/commands.tsx:2015`) confirms by name under the danger ritual, and `confirmSessionPurge` (`:2085`) calls `purgeThread`. That call erases the rows of the whole subtree. Neither function touches a file.

`deleteAnalysisWith` (`:1456`) is the precedent. `DeleteAnalysisFilesDialog` (`:1305`) asks first, and the answer rides as `"archive" | "delete"` into `disposeWorkspace`.

The harness gives the erased thread ids and the directory helper. This work consumes both.

## Goals / Non-Goals

**Goals:**

- A user decides the fate of the page files of each session that the erase removes.
- The decision reaches every report session of the subtree, and not the open thread alone.
- The flow spells no path of the harness.

**Non-Goals:**

- A change to the remove verb or to the restore verb. A tombstone keeps the row, thus its page still stands.
- A prune on any other trigger. A user who keeps 40 report sessions keeps 40 reports, and that is their choice.
- A second copy of the archive posture of the analysis delete.

## Decisions

### D1. The question is a yes or a no, and not the two-way choice of the analysis delete

The analysis delete offers `archive` or `delete`. An analysis holds inputs, run artifacts, and a provenance document, and a user can want each one after the row is gone.

A report-session directory holds a rendered page and a copy of the chart runtime. The document that produced it is a version in the database, which the same erase removes. Thus an archived page is a file that nothing can regenerate and nothing can explain.

The question is "remove the page files, or leave them". A user who leaves them keeps a directory that they can still open in a browser.

### D2. The question comes before the erase, and the removal comes after it

The confirmation and the file question are one ritual, thus the user answers both before anything runs.

The removal runs after the erase succeeds. A failed erase leaves the rows, and those rows still name their pages. To remove the files first would strip a session that survives.

### D3. The question is unconditional, and it tests no directory first

A conditional question wants the set of erased threads before the erase runs. That set arrives from the purge, which runs after the answer. The only other source is a listing before the erase, and D4 refuses one.

Thus the flow asks every time. The delete is irreversible, and one ritual with one shape is what a user can learn. A subtree with no page answers a question about nothing, and that costs one keystroke.

The removal then needs no existence test of its own. It removes each directory by force, thus an absent one is a success with no work.

### D4. The question is a second dialog, stacked over the confirmation

`ConfirmDeleteDialog` (`tui/commands.tsx:1262-1270`) carries a label, a name, a verb, a description, and one confirm callback. It has no field for an option.

The analysis delete already stacks the two: `commands.tsx:2586-2593` opens the confirmation, and its `onConfirm` opens the files dialog. The dialog host keeps a lower entry mounted, thus the stack preserves the state.

Thus this flow stacks the same way, and `ConfirmDeleteDialog` gains nothing. A toggle inside the confirmation would put a reversible choice inside the one ritual that means "this cannot be undone".

The two answers are "remove" and "keep". The analysis dialog names its own two `archive` and `delete`, and neither word fits here. Nothing archives a page, and "delete" already names the action that the ritual above confirmed.

### D5. The ids come from the purge, and not from a listing before it

A listing before the erase and the erase itself are two operations. A spawn between them makes a child that the erase removes and the listing never saw.

The purge gives back what it erased, thus the set is exact.

### D6. The removal runs before the landing, and one notice reports both

`confirmSessionPurge` notifies, unbinds the scope, and then lands the user on a surviving thread (`tui/commands.tsx:2094-2105`). That landing is a Postgres round trip.

The removal runs before the unbind. The notice then reports a finished outcome, and no file work races the landing.

One notice carries both facts, and it replaces the line at `tui/commands.tsx:2094`. Two notices for one action are two claims about one event, and the user reads them in whichever order the toasts stack.

### D7. The removal is best-effort, and it never fails the delete

The rows are gone when the removal runs. A failure to remove a directory cannot restore them, thus it must not read as a failed delete.

An unresolvable workspace root joins that same arm. The root is `<anchorPath>/.inflexa/analyses/<slug>`, and `workspaceRootForAnalysisId` gives a `Result` over it. A user can move or delete the anchor folder while the chat is open. `hasWorkspaceOnDisk` in the analysis ladder already treats that miss as a skip.

A directory that survives is reported in the outcome notice. The user keeps a truthful account, and the erase stands.

The path helper of the harness asserts its thread id, and a bad id throws. That throw joins the same arm: the directory stayed, and the notice names it. Each id comes from the harness, thus the arm is a guard and not a path that a user meets.

### D8. The existing busy gate is the block, and this work adds none

`purgeSessionFlow` refuses while a chat turn runs (`tui/commands.tsx:2041`). The gate sits before the dialog opens, and the modal blocks the composer, thus no turn starts in that window.

A render of a page runs inside a turn of its report session, and the chat holds one open session. Thus the gate that stops a turn stops a render, and a second gate would name the same state twice.

## Risks / Trade-offs

- [A user who declines keeps unreachable directories] → Accepted. They asked for it, and the notice names what stays.
- [The ritual grows one step on every delete] → Accepted. The delete is irreversible, thus one shape that a user learns beats two that depend on state.

## Migration Plan

The change is additive at one flow. A prior delete left its directories, and this work removes none of them after the fact.

## Open Questions

None.
