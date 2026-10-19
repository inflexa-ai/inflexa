## MODIFIED Requirements

### Requirement: Polls take the place of the bus

The server MUST NOT give a notification stream. The bus MUST stay inside the server process. Each client MUST read an endpoint again at its own edges and on its own schedule. Each push that a client must see MUST be state that an endpoint returns.

The TUI MUST keep one poll interval while an analysis is open. The interval is 5 s while work is active or a turn of a different client runs on the open thread, and 15 s otherwise. Each tick MUST do these reads:

- the runs and the data profile of the analysis, per `sidebar-live`
- a read of each run that the TUI observed non-terminal and that the runs read of the analysis does not hold, per `run-completion-notice`. The read is `GET {A}/run/:runId`. A run with an open read gets no second read, and at most 4 reads are open at one time.
- a probe of the server, `GET /api/v1/server`, per `tui-harness-chat`

When the server that the boot store saw ready answers the probe, the tick MUST also read these:

- the analysis, `GET {A}` with `touch=false`, per `workspace-context`
- the usage of the open session, per `sidebar-live`
- the turns of the open thread (`GET {T}/turns`, a page of one) and its row (`GET {T}`), per `tui-harness-chat`

Thus an idle TUI sees the work of a different client at most 15 s late.

#### Scenario: A run that a different client started

- **GIVEN** a TUI that is idle on an analysis
- **WHEN** a run of the analysis starts from a different client
- **THEN** the TUI shows the run at its next tick, at most 15 s later

#### Scenario: A server that does not answer gets no more reads

- **GIVEN** a TUI whose server stopped
- **WHEN** the poll ticks
- **THEN** the TUI sends the probe, and it sends no read of the analysis, the usage, or the thread
