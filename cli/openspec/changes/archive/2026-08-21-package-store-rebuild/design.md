# Design: package-store-rebuild (cli)

## Context

Main today bakes the store into the sandbox image, and the CLI makes no
`/mnt/libs` bind (`cli/src/modules/harness/runtime.ts:936-940`). The setup
pulls one variant image in the foreground, as its last step. The harness
change gives the seams, and the decision record gives the rationale. This
design maps the CLI side. The spike worktree stays the reference for the
mechanics that survived the grill.

## Goals / Non-Goals

**Goals:**

- Bind the seams at the composition root, with `per-analysis` farms.
- The `inflexa store` family, with the pending set and the two-phase flight.
- Three detached transfers from the start of setup, with live TUI rows.
- The post-plan package conversation, with per-package asks.

**Non-Goals:**

- The managed delivery. The build side (the harness change owns it).
- An R acquisition of the `github` and `git` tracks.

## Decisions

1. **The pending set is host state** (D16). An approved ask enqueues. The
   flight launches when the asks of the turn finish, and one provisioner run
   resolves the batch. No daemon container exists.
2. **The flight is two-phase** (D13, C2 of the audit). The acquire run
   stages the graph nodes as data. The flight runs the load check inside the
   sandbox image, then appends the staged nodes under the metadata lock.
   The download already writes the graph under that lock, thus the writer
   discipline is unchanged.
3. **Three independent transfer children** (Q8). Each transfer is one
   detached child with one database row. The lifecycle generalizes the spike
   catalog downloader: the lock is the liveness signal, and the receipt or
   the engine state is the truth of completion.
4. **The asks ride the run-inflexa approval** (Q16b). `store add` keeps
   `kind: "approval"`, thus each ask is one gated tool call. The refusal
   text returns to the agent as guidance.
5. **The both-hit ask covers link time too** (D15, W1 of the audit). The
   resolver refuses when both tracks of the pool hold the name, and the ask
   surfaces to the user. The Python-first search order dies.
6. **The delete gate hardens** (Q17b). The gate reads the live run state,
   and a stale `running` row with a dead holder reads as not live. No lease
   exists anywhere.
7. **The TUI reads rows by poll** (spike shape, kept). The transfer children
   are other processes, and the in-process event bus cannot carry their
   progress. The sidebar polls the rows, and the rows disappear on
   completion.

## Risks / Trade-offs

- [Three concurrent transfers contend for bandwidth] → The three rows make
  the contention visible, and the child count is fixed at three. No cap
  logic lands until a real problem shows.
- [A batch flight fails mid-set] → Per-spec outcomes are the contract. The
  failing spec reports its own refusal, and the rest lands.
- [The gate reads filesystem truth while a merge runs] → `store add`
  refuses during a live merge, and the receipt writes last, as in the spike.
- [The rename of config and lock keys touches persisted state] → The keys
  are process-local names, not persisted rows. The database migrations add
  only the transfer rows.

## Migration Plan

1. The change lands with the harness change linked (`bun run harness:local`).
2. A user with no store runs `inflexa setup`, and the three transfers start.
3. Rollback is a revert. The store directory is inert data that a revert
   simply stops reading.

## Open Questions

None that block the specs. The transfer-row shape and the exact prompt text
resolve inside the spec deltas and the implementation.
