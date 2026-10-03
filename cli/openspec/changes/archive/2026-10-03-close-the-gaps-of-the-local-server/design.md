# Design — close the gaps of the local server

## Context

The change `split-the-tui-from-a-local-server` made the TUI and the instance commands clients of one local server. A use of that server found gaps in three areas. These are the recovery of a failed boot, what an idle client sees, and the test of the machine before a profile. The code of this change is the truth, and this design records its decisions.

## Goals / Non-Goals

**Goals:**

- A person can recover each failed boot and a stopped server from the TUI.
- A client sees the work of a different client within one idle poll.
- Each profile drive of the server obeys one check of the machine.

**Non-Goals:**

- A notification stream from the server.
- The auth of a browser beyond the bearer token. The page at `/gui/` is a proof of concept of the dev channel.

## Decisions

### D1 — `inflexa up` hosts the provider sign-in

The boot of the server cannot ask for a login, because a background server has no terminal. Thus `inflexa up` runs the gate of the boot with the login prompt on a terminal. When the gate succeeds, `inflexa up` sends `POST /api/v1/server/boot` to a server whose phase is `failed`. The boot gives the reason `sign_in_required` for a missing or dead login, thus a client can offer the sign-in and not a new boot.

### D2 — The TUI recovers a failed boot

A failed boot is not a terminal state. The TUI offers one recovery in a dialog:

- `sign_in`: the TUI suspends its renderer and runs `inflexa up` in its terminal.
- `boot_again`: the TUI sends `POST /api/v1/server/boot`.
- `start_server`: the TUI starts a server through the spawn path of an instance command.

Enter answers "not now" for `start_server`, because the person possibly stopped the server on purpose.

### D3 — One poll for each client

The server pushes nothing. Thus the TUI keeps one interval while an analysis is open: 5 s with active work or a turn of a different client, and 15 s when idle. A tick refreshes the ledger and probes the server. Only when the server that the boot store saw ready answers, the tick reads the analysis, the usage, and the open thread. The probe also finds a stopped server and a new server.

### D4 — The server owns the sandbox gate

Each profile drive of the server asks one gate first: the chat open, the deliberate re-profile, and the input change. The read of the machine consumes a recorded farm failure, thus only the server reads it. The TUI holds a drive only while a transfer is live, and the server decides the rest.

### D5 — The server answers only its own address

A DNS rebind lets a web page send a request to 127.0.0.1 under its own host name. The page cannot change the `Host` and `Origin` headers. Thus the server refuses each request whose headers name a different address, before the bearer check.

### D6 — The removed store routes

The `store` commands run in their own process, because a cloud job runs them with no server. Thus the routes for the inventory, the adds, the catalog cancel, the reclaim, and the sandbox status had no client. With no reclaim route, the server runs no reclamation, and the reclaim exclusion in the process has no use.

## Risks / Trade-offs

- An idle client sends a probe and some reads each 15 s. The cost grows with the count of open clients, not with the data.
- A changed thread loads its whole transcript again, the same as an open.
- A different client sees a change up to 15 s late.
