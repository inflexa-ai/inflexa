## Context

`ask` (`src/tools/approval/gateway.ts`) reads a standing grant before it pauses.
The lookup keys on `(analysis_id, grant_key)`, and `cortex_ask_grants` carries
the same primary key. An analysis belongs to an organization, and each person
with execute access can answer its asks. Thus one `always` blesses the future
asks of every other person in that analysis.

`AskContext` carries `analysisId`, `threadId`, `signal`, and `emit`. It carries
no identity. The harness must not read the `auth` capability, and the managed
credential is an opaque bearer token. Thus only the embedder can name the person.

## Goals / Non-Goals

- Goal: an `always` binds the person that gave it.
- Goal: the seam stays host-agnostic. The harness takes an opaque string, and it
  never interprets the value.
- Non-goal: a revoke surface for a grant.
- Non-goal: a call site. No tool calls `ctx.ask`, and this change adds none.
- Non-goal: the cortex and lumen bind sites. They come in a later change.

## Decisions

- **`userId`, not `principalId`.** Nexus holds "principal" for the subject of an
  authorization grant. The harness cannot see that model, thus a `principalId`
  here would name a concept of a different system. `userId` is one plain word,
  and it binds the seam to no identity model.
- **The field is required.** An optional field gives the organization-wide grant
  to each embedder that omits it. The weak state must not be the quiet default,
  thus the typecheck asks the question one time at each bind site.
- **The grant belongs to the user of the turn.** `answer(id, reply)` keeps its
  shape, and the transaction reads `user_id` off the ask row. A grant answers
  "do not ask me again", and the next ask goes to the user of the turn. A person
  that answers the ask of a different person writes the grant of that person.
  That power is bounded: the same person can already approve the one action, and
  the grant covers one key in one analysis.
- **The analysis stays in the key.** The primary key becomes
  `(analysis_id, user_id, grant_key)`. The existing rule that a grant never
  crosses an analysis holds, and the person is a narrower scope on top of it.
- **The migration keeps each old row.** It adds `user_id` with an empty default,
  drops the default, and then replaces the primary key. An old row cannot get a
  person. The empty value matches no real user, thus the row is inert.
- **`cortex_asks.user_id` is nullable, as `grant_key` is.** The additive
  migration adds it with no backfill, and each new row writes it. The answer
  transaction reads it with `COALESCE(user_id, '')`, thus a row that predates
  the column can never write a grant that a real user matches.

## Risks / Trade-offs

- [A person answers the ask of a different person and writes that grant] → the
  scope is one grant key in one analysis. That person already holds the power to
  approve the action one time.
- [An old grant stops working] → the person answers the ask one more time, and
  the new grant carries the person. No row is deleted.
- [No revoke surface] → a per-user grant makes a revoke more necessary. This
  work leaves the gap as it stands, and `purge-analysis` still clears the table.

## Migration Plan

The DDL runs at boot inside the existing guarded block. The guard reads
`information_schema` for the column, thus the work runs one time and each later
boot is a no-op. A fresh database gets the shape from the `CREATE TABLE`.

A rollback must revert the DDL with the code. The old code writes an insert with
two key columns, and `user_id` carries no default after the migration.

## Open Questions

- A revoke route for a grant, and the surface that drives it.
- Whether a person must see a grant that a different person recorded for them.
