## Context

Archiving a thread stamps `deleted_at`, and `getThread`/`listThreads` both filter `deleted_at IS NULL` — which is what makes an archived thread read as absent everywhere. `unarchiveThread` clears the stamp, but its only parameter is a `threadId` that nothing in the store will hand back once the stamp is set. `Thread` carries no tombstone field either, so even a caller holding the id could not tell what state it was in.

The result is a capability that exists and cannot be exercised. It is not a spec violation — the unarchive scenario is written as "GIVEN an archived thread, WHEN `unarchiveThread` is called", which presumes the id is in hand — but it makes "the archive is recoverable" true only in the API's own terms, never in a user's. The paired CLI wants a restore command and has nothing to build it on.

## Goals / Non-Goals

**Goals:**

- Make an archived thread discoverable, so `unarchiveThread` has an obtainable input.
- Leave the default listing byte-identical to today's, so no existing caller changes behaviour.
- Let a host render an archived row *as* archived, rather than inferring it from which query returned it.

**Non-Goals:**

- Changing `getThread`. An archived thread staying indistinguishable from an absent one is relied upon: it is what lets a host treat a removed conversation as gone without carrying tombstone logic through every read path.
- A dedicated `listArchivedThreads`. A second method would duplicate the ordering, pagination, and counting of the first, and the two would drift.
- Purge discovery. `purgeThread` is unrecoverable by design, so nothing needs to enumerate what it removed.

## Decisions

**A flag on the existing input, not a second method.** `listThreads` already owns ordering, pagination, and the total/`hasMore` contract. Threading one optional boolean through the `WHERE` clause keeps a single implementation of all three; a sibling method would restate them and invite the two to disagree about what `total` counts.

**The flag widens the set; it does not switch it.** `includeArchived: true` returns live *and* archived threads, rather than archived only. A restore surface wants to show what is there — a user who archived the wrong conversation is looking for it among the ones they kept — and a caller that genuinely wants only the archived rows can filter on `deletedAt`, which this change makes possible. The reverse is not true: an archived-only listing cannot be widened by the caller.

**`deletedAt` is required on `Thread`, not optional.** The field is a read-model of a column that is always either null or a timestamp — there is no third state to represent with `undefined`. Optional would compile for a host that lists archived threads and never checks, rendering a tombstoned conversation as live, which is precisely the defect this change exists to prevent. The cost is a compile break for code that constructs a `Thread`; in this repository that is test fixtures only, and it lands in the same release as the `deleteThread` removal, so the pin bump absorbs one break rather than two.

**`total` and `hasMore` count the set the page was drawn from.** With the flag off they count live threads, with it on they count both. Any other choice would report a total the caller cannot page to.

## Risks / Trade-offs

- **A host lists archived threads and renders them as live** → The required `deletedAt` is what makes that a visible omission rather than a silent one; a renderer that ignores the field is choosing to, and the type showed it the choice.
- **The flag is a boolean, so "archived only" needs a client-side filter** → Accepted. The alternative is a tri-state enum whose third case has no caller today, and a boolean widens to one later without breaking the two cases that exist.
- **`updated_at DESC` interleaves archived and live rows** → Intentional: the ordering is "most recently active", and an archived thread's last activity is a real fact about it. A host that wants them grouped can sort on `deletedAt` itself.
- **Adding a field to a returned type is a compile break for constructors** → Confined to fixtures, mechanical to fix, and detectable only at the pin bump — which is why the proposal marks it BREAKING rather than treating it as additive.
