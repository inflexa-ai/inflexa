## Context

A CLI session identity is the harness Postgres thread id, one for one. A switch is an in-place store swap through `openSession`, and nothing relaunches. The chat reacts to the swap and it loads the transcript of the new thread.

The harness thread listing already answers each question that this work asks. It narrows by `type`, and it narrows by `parentThreadId`. A `Thread` carries `threadType`, `parentThreadId`, and `parentSeq`. Thus the CLI needs no new harness surface, and it adds none.

The palette holds the shape of a picker already. A flow reads its data before the dialog opens, and it reads the open analysis again after the await. A leader chord dispatches by id and it bypasses the `enabled` predicate, thus each flow restates its own boot gate.

## Goals / Non-Goals

**Goals:**

- One keybind pair moves in both directions, and each dead direction says why.
- One picker for each population, thus a list never mixes two kinds of thread.
- The chat entry point derives from the thread model alone.

**Non-Goals:**

- A browser for the CLI. Without one no report thread exists, and these surfaces then list nothing.
- Any harness change.
- The hosted view of a page, and the removal of the old report path.

## Decisions

### D1. The default chords are leader chords, and not ctrl-arrows

macOS binds a ctrl-arrow to its own window control, thus that chord never reaches the terminal on a stock machine. A leader chord reaches every terminal on every platform. The pair is remappable, thus a user who freed the ctrl-arrows binds them in the configuration.

The two ids join the remappable defaults beside the app keys. Thus the overlay that lists the reachable keys documents them with no second source.

The leader prefix sits at the binding, and not in the default value. `resolveKeybind` parses each default with `parseChord`, which reads a `+` alone, thus a value that holds `<leader>` and a space never matches a keystroke. The alternative was a resolution through `parseKeySpec`, which reads that grammar. It widens the return type from a chord to a sequence, and each app key that reads a chord today pays for two ids. Thus each id holds one chord, and the binding builds the sequence.

### D2. The right chord picks one child, and it opens a picker for several

A report child is the common case, and one child is the common count. A picker over one row asks the user to confirm what they already said. Thus the chord opens that child, and it opens a picker only when the count exceeds one.

The count comes from the same read in both arms, thus no second query decides the shape.

### D3. Each dead direction gives a notice

A silent no-op reads as a broken key. Thus each dead direction gives a notice that names its reason. There are three: the left chord in a conversation, the right chord in a report child, and the right chord in a conversation with no child.

### D4. The chat entry point derives from the listing, and not from a tool result

The alternative was a data part that the spawn tool emits, or a special case over the tool result in the transcript. Both bind the CLI to the shape of one tool, and both break when that shape moves.

The listing carries the parent link and the anchor already. Thus the CLI reads the report children of the open conversation and it places each entry at the anchor of that child. A child that a different host spawned appears the same way, and no emit is necessary.

The anchor names a store sequence number, and the display messages carry none. `storedMessagesToCortex` reads each stored message and it gives back the display messages alone. One row can open more than one message, thus the pair binds the row to its first message. The load path keeps that pair, and the entry then sits after the last message whose sequence number is not greater than the anchor.

### D5. One population serves the chord and the palette command

Both surfaces answer one question: which report children does the open conversation hold. Thus one read serves both, and one picker component renders both. A second listing would let the two disagree over the same question.

Issue #312 names the analysis as the scope of the palette command. The scope is the open conversation instead, because a report child belongs to the conversation that spawned it. An analysis holds many conversations, thus an analysis-wide list would mix the children of each one.

### D6. An archived child leaves every surface

The thread listing filters the tombstone, and an archive cascades over the whole subtree. Thus an archived report child disappears from the picker, from the chord, and from the transcript, with no rule of its own. The specification states it, because an implementer could otherwise add a read of the archived rows.

### D7. The narrowed switch picker is a behavior change, and it is stated

The switch picker lists every live thread today. It narrows to the `conversation` type. A user who reached a report session through that picker loses that route, and the new picker and the new chords replace it. The delta on `command-palette` records the narrowing, thus the change is not silent.

### D8. The launch resolves a conversation, and never a report child

The launch reads the most-recent live thread of the analysis. The listing orders by the last activity, thus a fresh report child is the newest row. A launch with no filter would open the report session, and the report agent would answer the first message.

The narrowing costs one filter on a read that the CLI already runs. The delta on `tui-harness-chat` records it, because the ready-edge resolution is a stated behavior of that capability.

## Risks / Trade-offs

- [The surfaces list nothing until a browser realization lands] → Accepted, and stated in the proposal. The coverage seeds a report thread in Postgres directly.
- [A leader chord costs two keystrokes] → Accepted for reach. The pair is remappable, thus a user picks a shorter chord.
- [The chat entry point costs one listing read] → The read narrows by the parent thread id. It runs when the open thread changes, and not for each turn.

## Migration Plan

The change is additive at the palette and the keymap. The narrowed switch picker is the one behavior that a user notices, and the two new surfaces cover the route that it drops.

## Open Questions

None.
