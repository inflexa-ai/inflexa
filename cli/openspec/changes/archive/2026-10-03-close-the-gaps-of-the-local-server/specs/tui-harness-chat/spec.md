## MODIFIED Requirements

### Requirement: Opening an analysis chat waits for the runtime of the local server behind a gate

Opening an analysis chat in the TUI MUST NOT boot a harness runtime in the TUI process. The local server owns the runtime and its prerequisites: the model connection gate, the container and proxy gate, and the harness config gate. It boots them at its own start, with no interactive prompt. Before the alternate screen, the launcher MUST resolve its target through the server. The read of the analysis takes its instance lock in the server. Thus an analysis that a different process holds MUST stop the launch with a plain line before the screen is taken.

After `render()`, the TUI MUST read the boot phase of the server (`GET /api/v1/server`) each 500 ms. It writes the phase into a boot-state store (`booting → ready | failed`), until the phase is `ready` or `failed`. While the phase is not `ready`, the chat input MUST be gated: a submit does nothing, and the input affordance and the status bar show the gate. A boot animation MUST render (a spinner and the elapsed time, in the design gallery). The surfaces of the session MUST show a placeholder or stay disabled, because the server reads the thread metadata from Postgres. These are the session line of the sidebar and the session-switch command.

When the store reaches `ready`, the TUI MUST resolve the conversation thread of the open analysis. It is the newest live thread of the `conversation` type that the server lists for the analysis. Otherwise it is a new thread id (`randomUUIDv7()`), whose row the first turn makes. The listing orders by last activity, thus without the type filter a new report child would be the thread of the next launch.

A failed boot, and a server that does not answer, MUST render one actionable message, never a hang or a dead screen: the boot error that the server gives, or the instruction of the client error. The failed state is not terminal. At each settle at `failed`, the TUI MUST offer one recovery in a confirm dialog:

- `sign_in`, for the boot reason `sign_in_required`: the TUI suspends its renderer and runs `inflexa up` in its terminal. A Ctrl+C there ends only the sign-in. A failed run waits for Enter before the renderer comes back. `inflexa up` asks the server to boot again, and the TUI follows that boot.
- `boot_again`, for each other boot error: the TUI sends `POST /api/v1/server/boot` and follows the boot. A refused request settles at `failed` with no recovery.
- `start_server`, for a server that does not answer: the TUI starts a server through the spawn path of an instance command. It shows `booting` while the start runs, and then it follows the boot. A failed start offers the start again with its reason.

Enter MUST answer "not now" in the `start_server` dialog, and the TUI MUST NOT start a server with no answer of the person. The person possibly stopped the server on purpose. A server that refuses the read gets no recovery, because a start cannot change a refusal. The header MUST show `server not running` for the `start_server` recovery, and `boot failed` for each other failure.

At each tick of the poll, the TUI MUST probe the server and keep the boot store true to it:

- No answer while the store is `ready`: the store settles at `failed` with the `start_server` recovery, one time.
- An answer while the store shows no server, or a boot failure that the server no longer has: the store follows that boot again.
- An answer of a different server, with a new start time, while the store is `ready`: the store follows that boot again. Thus the header, the sidebar, and the transcript read again at its `ready` edge.
- A server of a different API version: the store settles at `failed` with the message of the mismatch, one time, and it follows nothing.

When the store reaches `ready` by a different path, a recovery dialog that is still on top MUST close. A banner that a state of the server raised MUST clear at each `ready` edge, with the retained failure and the error status. Such a state is a server that does not answer, a drain, no runtime, or a broken turn stream. A failure of the model MUST stay.

Ctrl+C at each boot stage MUST quit the TUI through the graceful shutdown path, with the terminal restored. The quit stops nothing in the server: the server keeps its runtime for its other clients. No passive flow boots a runtime in its own process.

#### Scenario: Input is gated until the runtime is ready

- **WHEN** the TUI opens an analysis chat and the server reports the `starting` phase
- **THEN** submitting a message does nothing, the UI shows the boot state, and the first submit after `ready` starts a turn

#### Scenario: Thread resolves at the ready edge

- **WHEN** the boot store reaches `ready` for an analysis with prior live threads
- **THEN** the most-recently-active thread is resolved into the workspace scope and its transcript loads

#### Scenario: The launch never opens a report child

- **WHEN** the boot store reaches `ready` and the most-recently-active thread of the analysis is a report child
- **THEN** the launch resolves the most-recent conversation instead, and the report child opens through the report surfaces alone

#### Scenario: No threads yet means an empty chat, no row

- **WHEN** the boot store reaches `ready` for an analysis with no live threads
- **THEN** a fresh thread id is minted, the chat renders empty, and no thread row exists until the first message's turn creates it

#### Scenario: Boot failure is actionable, not fatal to the terminal

- **WHEN** the server reports a failed boot, for example Postgres down or a model that does not resolve
- **THEN** the TUI shows that actionable message and offers to boot the server again
- **AND** the user can quit cleanly with the terminal restored

#### Scenario: A sign-in from the chat

- **GIVEN** a server whose boot failed with the reason `sign_in_required`
- **WHEN** the person accepts the sign-in in the dialog
- **THEN** `inflexa up` runs in the terminal of the TUI, the server boots again, and the chat reaches `ready`

#### Scenario: A stopped server is offered a start

- **GIVEN** a TUI that is `ready`
- **WHEN** the person stops the server from a different terminal
- **THEN** at its next tick the header shows `server not running`, and a dialog offers the start with "not now" as the default

#### Scenario: A new server is followed back to ready

- **GIVEN** a TUI that shows `server not running`
- **WHEN** a command of a different terminal starts a server
- **THEN** the TUI follows the boot of that server to `ready`, closes the open dialog, and clears a banner that the stopped server raised

#### Scenario: Quit during boot restores the terminal

- **WHEN** the user quits while the server is still booting
- **THEN** the TUI exits through the graceful shutdown path with the terminal restored, and the server continues its boot

#### Scenario: A locked analysis stops the launch before the screen

- **WHEN** the launcher opens an analysis that a different live process holds
- **THEN** the launch prints the conflict and exits before the alternate screen is taken

### Requirement: One generation token orders every write to the message store

Each asynchronous producer that writes the conversation store MUST claim the same monotonic generation token at entry. It MUST check the token again after each `await`, before it writes the message store, the streaming signals, the error banner, or the chat status. These producers are a transcript load (`loadMessages`), a turn (`send`, through its emit adapter and `finishTurn`), and a retract (through its store splice and composer seed). The newest operation that started wins. Each older one MUST drop silently.

A turn thus supersedes a transcript load in flight. The load is a replay of durable state that the turn appends to, and the turn carries the live input of the user. A retract also supersedes a load in flight, because the load would replay the turn that the retract removes. `resetHotState` MUST also claim the token. Thus a load for a session that the user left can never fill the cleared store again. A retract that a session swap supersedes MUST drop its remaining store writes and its composer seed. Its durable removal of the thread turn, committed at the keypress, still completes.

The poll of the open thread (`pollOpenThread`) MUST NOT claim the token at entry. A poll that finds nothing new must not supersede a load. It records the token before its reads. It drops its result when the token moved, or when a send of this client is in flight. It claims a new token only to mount a changed transcript. The check of a send before its turn mounts under the token of that turn.

#### Scenario: A load resolving mid-turn does not wipe the turn

- **WHEN** `loadMessages` is awaiting its page read and the user submits a turn, and the page read then resolves
- **THEN** the load drops without a write
- **AND** the user message and the in-flight assistant message stay mounted
- **AND** the next streamed parts append to that assistant message

#### Scenario: A turn submitted the instant boot completes survives

- **WHEN** the runtime reaches `ready`, the transcript load starts, and the user submits a message typed during the boot animation
- **THEN** the turn renders normally, and the transcript load drops

#### Scenario: A load started for a swapped-away session never lands

- **WHEN** `loadMessages` is in flight for session A and `resetHotState` runs for a swap to session B
- **THEN** the session-A load drops without a write

#### Scenario: A load resolving mid-retract does not resurrect the retracted turn

- **WHEN** `loadMessages` is in flight and a retract claims the token, and the page read then resolves
- **THEN** the load drops without a write, and the spliced store stays spliced

#### Scenario: A swap mid-retract drops the UI writes, not the thread removal

- **WHEN** `resetHotState` supersedes a retract after its abort settled
- **THEN** no store write or composer seed lands, and the old thread's orphan turn is still removed

#### Scenario: A poll during a send mounts nothing

- **GIVEN** a send of this client whose turn runs
- **WHEN** the poll reads the open thread and finds a new `updatedAt`
- **THEN** the poll mounts nothing, and the turn keeps its messages

### Requirement: The user can re-trigger profiling manually

The TUI MUST offer a deliberate re-profile action: a command-palette entry, and a keybound action inside the DATA PROFILE details dialog (per `sidebar-live`). The two surfaces MUST use one path: the hold of the transfers, then `POST {A}/data-profile/rerun`. The server forces the stage → seed → trigger sequence with no drift test. A completed row restarts through the CAS of the trigger. A `failed` row is retry-claimed and started. A `running` profile MUST refuse with a notice and start nothing.

Each outcome MUST show as a notice and poke the live store of the sidebar. A refusal of the sandbox gate of the server (409 `conflict`) MUST show as a could-not-start notice with the line of the server. When a re-profile cannot start, each surface degrades in its own way. The palette entry refuses with a notice before the runtime is `ready`, or on an analysis with no resolvable inputs. The dialog action is not offered: no footer hint and no binding (per `sidebar-live`).

#### Scenario: Re-profile restarts a completed profile

- **WHEN** the user invokes "Re-profile data" on an analysis whose profile completed — drifted or not
- **THEN** the profile workflow restarts, a notice reports it, and the sidebar shows it running

#### Scenario: Re-profile recovers a failed profile

- **WHEN** the user invokes the re-profile action on an analysis whose profile status is `failed`
- **THEN** the failed row is retry-claimed, the workflow starts, and the failure state clears from the sidebar

#### Scenario: Re-profile while running refuses

- **WHEN** the user invokes the re-profile action while a profile is running
- **THEN** a notice says a run is already in progress and no duplicate workflow starts

#### Scenario: Re-profile on a machine with no sandbox image

- **GIVEN** an analysis with inputs, and no sandbox image in the engine
- **WHEN** the user pushes the re-profile key in the DATA PROFILE details dialog
- **THEN** the server refuses the drive, and a could-not-start notice names `inflexa sandbox pull`

### Requirement: The local server keeps the data profile at parity, and the TUI asks at its edges

The TUI MUST keep the data profile at managed parity with the **current input set** of the analysis. The local server runs each drive. The TUI MUST ask the server for the chat context (`GET {A}/chat-context`), which runs the open drive of `data-profile-launch`, at two edges:

- when the boot store reaches `ready` with an analysis open, and again when the open analysis changes in place. The ask is de-duplicated by the analysis id, thus a repaint or a settled boot phase does not ask again.
- one time when a profile that the sidebar saw `running` reaches a terminal state for the same analysis. The state is `completed` **or** `failed`, thus the work that the running skip deferred goes out on each outcome.

Each of these drives MUST wait while a transfer is live, per `package-store-transfers`. Then the server decides if a sandbox can start, per `local-server`. A refusal of its gate gives the outcome `failed` with the line of the gate.

The server MUST re-profile after an input change itself, from each writer in its process: an input route of a client, and the `manage_inputs` tool inside a turn. Each change arms a 500 ms trailing debounce for its analysis, thus a batch edit gives one input-change drive. The change waits for the ready runtime and for the sandbox gate, per `local-server`. No TUI edge watches the inputs, and the re-profile runs when no TUI is open. After an input change of this client, the TUI MUST read the sidebar again. The `workPending` flag of the data profile keeps the poll fast until the row shows the drive.

The server MUST **serialize** each drive of one analysis through one queue for each analysis: the open drive, the input-change drive, and the deliberate re-profile. Only one drive runs its materialize → seed → trigger sequence at a time. A drive that arrives while another runs MUST queue behind it and MUST NOT drop, because the edges fire when state changed. The CAS of the ledger runs only after the staging, thus it cannot give this serialization. Concurrent `stageInputs` calls on one workspace tree race the delete of the tree reconciliation. A concurrent clear can also null `seed_input_file_ids` between the seed write and the trigger of a different drive. What a drive decides is the contract of `data-profile-launch`: the materialization, the profile decision, the clear of an emptied set, and the running skip.

The TUI MUST map the outcome of a drive that it asked for onto notices. A trigger raises a profiling or re-profiling notice. A clear raises an informational notice that the analysis has no inputs. A failure raises a could-not-start notice with its reason. Each other outcome is silent. A trigger and a clear MUST poke the live store of the sidebar, because they change the ledger outside its own refresh triggers.

The chat MUST NOT wait for the profile state. The server answers when the trigger is dispatched, never at the end of the profile. A drive whose analysis was swapped away during its request MUST drop its notice and its poke of the sidebar. The drive itself completes in the server.

#### Scenario: First open of an analysis with inputs profiles it

- **WHEN** the TUI opens an analysis that has inputs but has never been profiled
- **THEN** the profile workflow is triggered without blocking the chat, and a notice reports it started

#### Scenario: Chat is never blocked on the profile

- **WHEN** the chat-context drive triggers a profile workflow on chat open
- **THEN** the chat accepts turns immediately and the server answers as soon as the trigger is dispatched

#### Scenario: Chat is usable while the profile runs

- **WHEN** the profile workflow is still running
- **THEN** a submitted message runs a normal turn (no gate, no refusal)

#### Scenario: Adding an input to a profiled analysis re-profiles it

- **GIVEN** an analysis whose profile completed, and a server whose runtime is ready
- **WHEN** an input is added through the file picker, a command, or the `manage_inputs` tool of the agent
- **THEN** the server re-triggers the profile with no further user action, and the sidebar shows the profile running at its next read

#### Scenario: A burst of input edits gives one drive

- **WHEN** one edit removes some inputs of an analysis
- **THEN** the server runs one input-change drive after the burst, not one drive for each input

#### Scenario: A run that fails still releases work deferred by the running-skip

- **GIVEN** inputs changed while a profile was running, so the drive skipped
- **WHEN** that profile reaches `failed` rather than `completed`
- **THEN** the terminal-state edge asks for the chat context again, and the server materializes the changed input set

#### Scenario: Edits during a running profile are caught at completion

- **WHEN** inputs change while a profile is running
- **THEN** the drive skips (already running), and when that profile completes the TUI asks again and the server acts on the changed set

#### Scenario: Two drives of one analysis do not race the workspace tree

- **WHEN** an input-change drive and a chat-context drive arrive for one analysis while a drive of that analysis is staging
- **THEN** the later drives run only after the first completes
- **AND** `stageInputs` never runs concurrently for one analysis

#### Scenario: A clear cannot wipe a concurrent drive's seed

- **WHEN** one drive observes an emptied input set and clears the ledger while another drive is seeding a non-empty set
- **THEN** the two do not interleave, and no drive reports a start failure that the clear of the other caused

#### Scenario: Removing every input clears the profile

- **WHEN** the user removes the last input of an analysis with a completed profile
- **THEN** the server clears the profile, and the DATA PROFILE section returns to "not profiled" at its next read

#### Scenario: A swap drops a stale notice

- **WHEN** the user swaps to a different analysis while a chat-context request for the first analysis is in flight
- **THEN** the TUI raises no notice and pokes no sidebar read for the first analysis

#### Scenario: A chat open while the catalog downloads

- **GIVEN** a live catalog transfer, and an analysis with inputs that was never profiled
- **WHEN** the TUI opens the analysis
- **THEN** the drive waits with one notice, and it goes to the server when the transfer ends

## ADDED Requirements

### Requirement: The TUI shows the work of a different client on the open thread

The server pushes nothing, thus the TUI MUST read the open thread at each tick of its poll. The tick reads the thread only when the server that the boot store saw ready answers the probe. It MUST read the turns of the thread (`GET {T}/turns`, a page of one, the running turns first) and the row of the thread (`GET {T}`).

- A running turn on the thread while this client sends none is the turn of a different client. The header MUST show `other client's turn`, and the poll MUST use its fast cadence.
- The row MUST go to the session rail: a title that a different client gave, or the row that the first turn of a different client made. The rail MUST write only when the row moved.
- The TUI MUST keep the `updatedAt` of the row from a read made before the transcript read of its last mount. A different `updatedAt` MUST mount the transcript again. Thus a write between the two reads shows at the next check.

A mount writes through `reconcile` by message id. A message that did not change keeps its object, thus its block does not mount again. Before a send, when the store shows the transcript of the same thread, the TUI MUST read the row. When the row moved, it MUST mount the transcript again before the turn starts. Thus the screen holds what the model reads.

#### Scenario: A turn of a different client

- **GIVEN** two TUIs on one thread of one server
- **WHEN** the first TUI sends a message
- **THEN** the header of the second TUI shows `other client's turn` at its next tick
- **AND** the second TUI shows the new messages at the first tick after the turn ends

#### Scenario: A send after a turn of a different client

- **GIVEN** a different client that wrote a turn to the open thread after the last mount of this TUI
- **WHEN** the person sends a message before the next tick
- **THEN** the TUI mounts the transcript of the server first, and then it starts the turn

### Requirement: A sub-agent iteration shows as thinking

A sub-agent frame of the type `iteration` marks the start of a model request of that sub-agent. It MUST set the activity line of the running tool call to `<agentId>: thinking`. The TUI and the dev `chat` REPL MUST use one reader of the label, thus the two show the same line. A sub-agent between two tool calls thus shows that it thinks, not the line of its last call. The root agent gives no `iteration` frame.

#### Scenario: The planner thinks between two calls

- **GIVEN** a turn whose tool call runs the planner
- **WHEN** the planner finishes a tool call and starts its next model request
- **THEN** the activity line of the running tool call reads `planner: thinking`
