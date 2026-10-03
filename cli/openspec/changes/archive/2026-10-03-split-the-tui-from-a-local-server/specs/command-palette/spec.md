## MODIFIED Requirements

### Requirement: Phase-1 commands run in-app over shared cores

The palette SHALL ship the command set that needs no chat swap: Settings (embed the existing config screen as a dialog), Change theme (apply `setTheme` and persist via `writeConfig`), Open output folder (ask the local server to make sure that the output folder of the current analysis exists, then open the path that the server gives — the route that `inflexa open` uses), Show status (render the context description that the resolve route of the server gives for the chat's working directory, in a results dialog), List analyses (render the analyses that the server lists, in a results dialog), New project (a prompt dialog that makes the project through the server, with `Str256` validation at the boundary), and Quit (`ctx.quit()`). These commands SHALL reach the state of the analyses through the same routes of the local server that the matching text commands use, never through the database or a module that holds state, and SHALL surface results via dialogs or `ctx.notify`, never stdout.

#### Scenario: Open output folder reuses the core

- **WHEN** "Open output folder" runs with an analysis open
- **THEN** the server makes sure that the folder exists and gives its path, the TUI opens that path, and a notice names it — the same route that the `inflexa open` command uses

#### Scenario: Read-only result renders in a dialog

- **WHEN** "List analyses" runs
- **THEN** the analyses that the server lists render in a dialog, not to stdout

#### Scenario: New project over the shared core

- **WHEN** "New project" is submitted with a valid name
- **THEN** the server makes the project and the outcome is shown via `ctx.notify`

#### Scenario: Open output folder disabled without an analysis

- **WHEN** no analysis is open in the chat
- **THEN** "Open output folder" is not offered (its `enabled` returns false)

#### Scenario: Empty results render an empty state

- **WHEN** "List analyses" runs and there are no analyses
- **THEN** the results dialog shows an empty-state message, not a blank list

### Requirement: In-place session-switching commands

Building on the reactive chat screen (see the `chat-wiring` capability), the palette SHALL provide Switch analysis, Switch session, New analysis, and New session commands that swap the open chat in place via `ctx.openSession(threadId, workingDir, analysis)` without relaunching the process. Switch analysis SHALL present a picker over the analyses that the local server lists. Switch session SHALL present a picker over the live conversation threads that the server lists for the analysis with the `conversation` type, most-recently-active first, and SHALL be offered only when an analysis is open and the boot state is `ready` (the server reads thread metadata from Postgres, which has no pre-`ready` source). The narrowing to the `conversation` type keeps one population in this picker; a report child reaches the user through the report-session navigation instead. New analysis SHALL prompt for a name, make the analysis through the server, and open it (a deliberate action, so minting its anchor marker is allowed); opening it resolves no existing thread, so a fresh thread id is minted and the row is created by the first turn. New session SHALL mint a fresh thread id inline and swap the open chat onto it in place — no row is written until the first turn creates it, typed `conversation` by the harness default with its title seeded from the message — and SHALL be offered under the same gate as Switch session; a dispatch by id while the boot state is not `ready` SHALL raise a notice (warn on `failed`, an in-progress notice otherwise) and leave the scope unchanged. The Switch session picker SHALL carry a pinned "Start a new session" row that stays present under any filter query and when the analysis has no listed threads; selecting it SHALL act exactly as New session. A New session invoked during a streaming turn SHALL behave as any same-analysis session swap: the reactive chat reset on the `sessionId` change aborts the in-flight turn. Any picker over an empty set SHALL show an empty-state message rather than a blank list.

#### Scenario: Switch analysis in place

- **WHEN** the user picks a different analysis from the palette
- **THEN** the chat swaps to that analysis's most-recent live thread (or an empty chat when it has none) without a process restart

#### Scenario: Switch session lists pg threads

- **WHEN** the user opens "Switch session" with the runtime `ready`
- **THEN** the picker lists the analysis's live conversation threads that the server reads from the thread store, most-recently-active first

#### Scenario: The switch picker holds no report session

- **WHEN** the analysis holds a report child and the user opens "Switch session"
- **THEN** the picker lists no report session, because the listing narrows to the conversation type

#### Scenario: New analysis from the palette

- **WHEN** "New analysis" is submitted with a name
- **THEN** a new analysis is created and opened in place, with no thread row until the first message

#### Scenario: New session from the palette

- **WHEN** "New session" runs with an analysis open and the runtime `ready`
- **THEN** the chat swaps in place onto a freshly minted thread id under the same analysis, no row exists until the first message, and the sidebar shows the fresh-conversation placeholder

#### Scenario: New session cannot produce a non-conversation thread

- **WHEN** the first message is sent on a thread id minted by "New session"
- **THEN** the harness creates the row with its default `conversation` type, because no call on this path accepts a thread type — a construction property the `openSession` signature and the chat request enforce at compile time, carrying no runtime check for a test to cover

#### Scenario: The switch picker offers creation

- **WHEN** the user opens "Switch session", including when the analysis has no listed threads or the filter query matches nothing
- **THEN** a pinned "Start a new session" row is present, and selecting it swaps the chat onto a fresh mint

#### Scenario: Switch session requires an analysis and a ready runtime

- **WHEN** no analysis is open in the chat, or the boot state is not `ready`
- **THEN** "Switch session" and "New session" are not offered (their `enabled` returns false)

#### Scenario: New session dispatched by id before ready

- **WHEN** "New session" is dispatched by id — a path that skips `enabled`, live for tests today and for any future chord or keybind remap — while the boot state is not `ready`
- **THEN** a notice speaks the refusal (warn on `failed`, "still booting" otherwise) and the open scope is unchanged

#### Scenario: Empty picker shows an empty state

- **WHEN** "Switch analysis" runs and there are no other analyses
- **THEN** the picker shows an empty-state message rather than a blank list

### Requirement: Verify provenance command in palette

The system SHALL add a "Verify provenance (internal)" entry to the command palette with `id: "prov.verify"`, `category: "Analysis"`, enabled when `ctx.analysis !== null`. The action SHALL ask the local server to verify the provenance chain of the analysis, format the result with the provenance kernel, which it loads lazily, and display it via `notify`. A request that fails SHALL raise an error notice.

#### Scenario: Verify command appears when analysis is open

- **WHEN** the command palette is opened with an analysis active
- **THEN** "Verify provenance (internal)" is listed in the Analysis category

#### Scenario: Verify command is hidden without an analysis

- **WHEN** the command palette is opened with no analysis active
- **THEN** "Verify provenance (internal)" does not appear

#### Scenario: Verify result is shown as a notice

- **WHEN** the user selects "Verify provenance (internal)"
- **THEN** a notice is displayed: info for valid/unsigned/empty, warn for no-key, error for tampered

#### Scenario: A failed request gives an error notice

- **WHEN** the user selects "Verify provenance (internal)" and the request to the server fails
- **THEN** an error notice says that the provenance data could not be read

### Requirement: The delete-session command offers to remove the page files it orphans

The delete-session command MUST offer to remove the page files that its erase orphans. It erases a thread and every descendant of it. A report session owns a page directory on disk, named by its thread id. That id is gone after the erase, thus no surface can name the directory again.

The flow MUST ask in the same ritual as the name confirmation. Thus the user answers once, and nothing runs before that.

The flow MUST ask on every delete, and it MUST test no directory first. The delete is irreversible, thus the user meets one ritual and never two shapes of it. A subtree with no page on disk answers a question about nothing, and that costs one keystroke.

The two answers MUST be "remove" and "keep". Nothing archives a page, thus the two-way choice of the analysis delete does not carry here.

The erase and the removal MUST be one request to the local server, which carries the answer. The server MUST remove the pages only after the erase succeeds. The flow MUST unbind the scope after that request and before the landing. The landing is a server round trip, and a bound scope that names an erased thread across it lets a turn mint the row back.

One notice MUST report both the erase and the fate of the files, in place of the success line that the flow raises today. Two notices for one action are two claims about one event.

A refused erase and a failed erase each leave every file, because the rows that name those pages survive.

The set of directories MUST come from the ids that the purge gives back. A listing before the erase and the erase itself are two operations. A spawn between them makes a child that the erase removes and the listing never saw.

The server MUST name each directory through the helper that the harness exports. It MUST spell no directory name of its own, because the layout of a workspace belongs to the harness.

The removal MUST be best-effort. The rows are gone when it runs, thus a directory that survives MUST NOT read as a failed delete. An absent directory MUST NOT read as a failure either. The outcome notice MUST name what stayed.

A workspace root that does not resolve MUST remove nothing, and the notice MUST tell its two causes apart. A tree that was never written holds no page, thus the notice MUST report that no page remains. A tree that the server cannot locate can hold one, thus the notice MUST warn and MUST give that cause. One line for both would send the user to the anchor for a page that never existed.

The flow MUST keep the gate that it has on a running chat turn of this client. A render of a page runs inside a turn, thus that one gate covers a delete that would race a write into the same directory.

#### Scenario: A delete with a report child asks about the files

- **GIVEN** an open conversation with one report session that rendered its page
- **WHEN** the user runs the delete-session command and confirms the name
- **THEN** the flow asks whether to remove the page files before it erases anything

#### Scenario: A delete with no page on disk asks the same question

- **GIVEN** an open conversation with no report child
- **WHEN** the user runs the delete-session command and confirms the name
- **THEN** the flow asks the same file question, and the removal that follows finds nothing and reports no failure

#### Scenario: The answer reaches every erased session

- **GIVEN** an open conversation with two report sessions, each with a page on disk
- **WHEN** the user confirms the delete and accepts the removal
- **THEN** both page directories are gone

#### Scenario: A delete from inside a report session removes its own page

- **GIVEN** the user opened a report session and reads its page
- **WHEN** the user runs the delete-session command, confirms the name, and accepts the removal
- **THEN** that one thread is erased, its page directory is gone, and the parent conversation is unchanged

#### Scenario: A declined removal keeps each file

- **WHEN** the user confirms the delete and declines the removal
- **THEN** the rows are erased, and each page directory stays on disk

#### Scenario: A failed erase leaves each file

- **GIVEN** a delete that the store refuses
- **WHEN** the failure is observed
- **THEN** no page directory is removed, and the notice reports the failed delete

#### Scenario: A directory that resists removal does not fail the delete

- **GIVEN** a confirmed delete whose rows are erased
- **WHEN** one page directory cannot be removed
- **THEN** the delete reports its success, and the notice names the directory that stayed

#### Scenario: An analysis with no workspace tree reports that no page remains

- **GIVEN** an analysis that ran nothing, thus it has no workspace tree on disk
- **WHEN** the user confirms the delete and accepts the removal
- **THEN** the notice reports that no report page remains, and it raises no warning

#### Scenario: A workspace that the host cannot locate warns

- **GIVEN** an analysis whose workspace tree the server cannot locate
- **WHEN** the user confirms the delete and accepts the removal
- **THEN** the notice warns that the pages stayed, and it gives that cause
