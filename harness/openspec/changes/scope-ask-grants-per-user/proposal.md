## Why

`cortex_ask_grants` keys a standing grant on `(analysis_id, grant_key)`. An
analysis belongs to an organization, and more than one person can work in it.
Thus an `always` from one person auto-approves the turn of a different person,
and that person never sees the ask. The gate exists to make a person decide. A
grant that crosses persons removes that control.

The harness cannot derive the person. It must not read the `auth` capability,
and the credential it carries is opaque. Thus the embedder must supply the
identity as plain data.

## What Changes

- `AskContext` gets a required `userId`. An embedder that omits it fails the
  typecheck, thus the wide grant cannot be the quiet default.
- `cortex_ask_grants` keys on `(analysis_id, user_id, grant_key)`. One grant
  applies to one person in one analysis.
- `cortex_asks` records `user_id`. The ledger says who each ask went to, and the
  answer transaction reads the value back to write the grant.
- `pending()` reports `userId`, thus a host can route an unresolved ask to the
  correct person.
- The CLI passes its one local identity at the bind site. No other consumer of
  the seam is in this repository.

No tool calls `ctx.ask` today. This change builds the support only, and it
connects no tool.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tool-approval`: a standing grant belongs to one person inside the analysis,
  not to the analysis. The ledger records the person of each request.

## Impact

- `src/state/init.ts` — `user_id` on both tables, and a guarded migration for
  the new primary key.
- `src/tools/approval/gateway.ts` — `AskContext.userId`, threaded into the row
  and into the grant lookup.
- `src/tools/approval/queries.ts` — `AskRow.userId`, `selectGrant` takes the
  user, both inserts write the column, and the answer transaction keys the grant
  on it.
- `src/tools/approval/gateway.test.ts` — per-user grant coverage.
- `cli/src/tui/hooks/conversation.ts` — the CLI binds its local identity.
- Cortex and lumen give the value at their own bind sites, in a later change.
