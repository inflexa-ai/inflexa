## Context

The shell already holds the one fact that every surface needs. `openThread` in `src/tui/hooks/thread.ts` is a reactive snapshot of the open thread row, and the row carries `threadType` and `parentThreadId`. The spawn writes a report row before the child opens, thus a report session always loads with its type. No new store and no new query channel is necessary for the marking. The clipboard writer (`src/lib/clipboard.ts`) and the toast pattern exist. The report picker and its listing exist in `src/tui/commands.tsx` and `src/tui/hooks/report_children.ts`.

## Goals / Non-Goals

**Goals:**

- Mark an open report session on the footer, the status bar, and the SESSION rail.
- Make the full session id copyable from the chip and from the palette.
- Show the absolute created time in the SESSION rail.
- List the sibling report sessions from inside a report session, with ids on the picker rows.

**Non-Goals:**

- No recolor of the shell chrome beyond the scope word and the segment. A session-toned theme role touches ten palettes and the contrast tests, and it waits for a later change.
- No change to the forward and back chords.
- No change to the switch-session picker of the conversations.
- No harness change.

## Decisions

- **The kind source is the `openThread` snapshot.** The snapshot is already reactive, bound at the ready edge, and blanked on a swap. The alternative — a second read path per surface — would mint a second staleness rule. Rejected.
- **The parent title rides the open-thread refresh.** When the loaded row is a report child, `refreshOpenThread` also reads the parent row, under the same generation token. The snapshot gains an optional parent field: the id and the title. A failed parent read leaves the field empty, and the kind line renders alone. The alternative — a read at render time in the sidebar — would put an async query into a render path. Rejected.
- **The scope word tones come from existing roles.** `REPORT` renders bold in the accent role, and `ANALYSIS` renders muted. This obeys the theme rule (no new hex, no new role) and it costs nothing across the ten palettes. A dedicated role was considered and rejected for scope.
- **The dumb components stay dumb.** `ChatBar` and `StatusBar` take the words as props. `app.tsx` derives them from `openThread()` in one place, thus the two surfaces can never disagree.
- **The copy goes through `writeClipboard` with the existing toast.** The chip is the click target in the sidebar, and the palette command `session.copy-id` covers the keyboard route. The command reads `workspace.sessionId`, thus it needs no boot gate. The full-id-in-the-rail alternative was rejected: 36 characters do not fit the rail width.
- **The sibling listing reuses `readReportChildren` with the parent id.** When the open row is a report child, the palette flow passes `parentThreadId` as the parent. The population stays one query, and the picker component is unchanged. The open session's row carries an "open" marker in its label, and its pick closes with no swap.
- **The absolute time uses the sidebar's `absTime` helper.** The same rendering as the completed-profile line, thus one vocabulary.
- **The picker ids join the existing row shape.** The row label gains the short id chip, and the detail line gains the full id beside its timestamp. The `SelectDialog` detail line already renders per-row data, thus no dialog change.

## Risks / Trade-offs

- [The parent read adds a round-trip to the report-session swap.] → It rides the same refresh and the same token. The rail renders the kind line first, thus a slow parent read gives a title-less line, never a blank rail.
- [A stale snapshot could mark a conversation as a report.] → The refresh blanks the snapshot synchronously on an id change. The scope word then drops to the unresolved state, and that state shows no word.
- [The absolute time can outgrow the one-row layout on narrow rails.] → The section falls back to the stacked layout by the existing fit rule. No new layout logic.
- [A clipboard write can fail silently on exotic terminals.] → `writeClipboard` does both OSC 52 and the native tool, and it logs a failure. The toast follows the existing app-level pattern.

## Open Questions

None.
