## Why

No code makes a thread of the type `report`. The data model and the agent lookup from #224 are in place, and the version store from #308 waits for a session to feed it. This change adds the spawn operation that #309 tracks, and it locks the session-version policy from the #221 discussion into the spec tree.

## What Changes

- Add a public read of the latest `messages.seq` value of a thread. The append path computes it privately today, and the spawn needs the same value as the anchor.
- Add the spawn operation. It makes a child thread with the type `report`, the parent thread id, and the anchor. It reads the anchor at the moment of the spawn, without a lock.
- The spawn refuses an absent or archived parent, and it refuses a parent with an empty transcript. It also refuses a parent that is not a conversation, thus a report session cannot nest. Each refusal is typed data.
- The spawn composes the child title as `{parent title} — Report N`. N counts the existing report children plus one. When the parent holds no title, the title is `Report N`.
- Add the children listing: the report sessions of one analysis, through the existing thread listing filters.
- Add the session-version policy to the `report-versions` spec: a caller records at most one version for each report thread.

## Capabilities

### New Capabilities

- `report-session-spawn`: the operation that makes a report child thread, its refusals, its title rule, and the children listing.

### Modified Capabilities

- `report-versions`: one added requirement on the caller of the store. One report session records at most one version, and a correction is a new session. The store behavior does not change.

## Impact

- New code in `harness/src/app/` for the spawn, and one added read in `harness/src/memory/thread-history.ts`.
- The work is additive and dormant. No agent roster changes, and `src/index.ts` exports none of it. The resolver still refuses the type `report` until #225 registers an agent.
- No new dependency, and no schema change.
