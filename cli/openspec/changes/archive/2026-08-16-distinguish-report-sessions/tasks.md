## 1. The open-thread snapshot carries the report context

- [x] 1.1 Extend `refreshOpenThread` in `src/tui/hooks/thread.ts`: when the loaded row is a report child, read the parent row under the same generation token.
- [x] 1.2 Extend `ThreadSnapshot` with an optional parent field (the id and the title) on the loaded arm. A failed or absent parent read leaves the field empty.
- [x] 1.3 Unit tests with the injected seams: the parent lands for a report row, a failed parent read keeps the loaded row, and a conversation row reads no parent.

## 2. The footer scope word

- [x] 2.1 Add the scope-word props to `ChatBar` (`src/tui/layout/chat_bar.tsx`): the word and its treatment, as data. Render `REPORT` bold in the accent role, and `ANALYSIS` muted, beside the mode word.
- [x] 2.2 Derive the word in `app.tsx` from `openThread()`: loaded report gives `REPORT`, loaded conversation or absent gives `ANALYSIS`, and unresolved gives no word.
- [x] 2.3 Render tests: the three states, with span-color assertions for the accent treatment.

## 3. The status-bar scope segment

- [x] 3.1 Add the optional scope segment to `StatusBar` (`src/tui/layout/status_bar.tsx`), rendered in the accent role after the subtitle and before the state segment.
- [x] 3.2 Pass the segment from `app.tsx` only while the open thread loads as a report row.
- [x] 3.3 Render tests: the segment shows on a report thread, and a conversation shows none.

## 4. The SESSION rail

- [x] 4.1 Replace the relative age with the absolute created time in `src/tui/layout/sidebar.tsx`, through the existing `absTime` helper.
- [x] 4.2 Add the report context line: the kind with the parent title from the snapshot. An empty parent field renders the kind alone.
- [x] 4.3 Make the id chip a click target: the click copies the full thread id through `writeClipboard`, with the "Copied to clipboard" notice.
- [x] 4.4 Add the palette command `session.copy-id` ("Copy session id", Session category) in `src/tui/commands.tsx`, offered only while a session is bound.
- [x] 4.5 Tests: the absolute time, the context line with its degrade, the chip-click copy with its notice, and the bound-session gate of the command.

## 5. The report picker

- [x] 5.1 In `openSwitchReportSession`, list the children of `parentThreadId` when the open thread is a report child.
- [x] 5.2 Name the open session in its row, and close the dialog with no swap when the user picks it.
- [x] 5.3 Add the short session id to each row label, and the full id to the detail line beside its timestamp, in `reportSessionItems`.
- [x] 5.4 Tests in the report-session flows suite: the sibling listing, the open-row pick, the id rows, and the unchanged conversation-side behavior.

## 6. Verification

- [x] 6.1 Update the design-gallery exhibits of the changed surfaces where one exists, thus the gallery stays the source of truth.
- [x] 6.2 Run `bun run format:file` on each changed source file, then `bun run typecheck` in `cli`.
- [x] 6.3 Run the targeted test files of the changed surfaces alone, never the full suite.
