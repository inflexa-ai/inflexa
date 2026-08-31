# Design: store-add-raw-name

## Context

The flight canonicalizes the request name at the enqueue (`store_flight.ts:175`) and drops the raw spelling. The provisioner spec then reuses that identity (`store_flight.ts:111`), thus pak receives `go-db` for `GO.db`. The provisioner itself already speaks raw R names: `r_repos_hold` probes raw, and a both-hit answer keeps the R candidate raw (`provision.py:1256-1258`). The two halves disagree on the contract, and the CLI side is the wrong one.

## Goals / Non-Goals

**Goals:**

- The installer, and every user-facing render, receives the raw spelling.
- The keys, the pool, and the graph keep the canonical identity, unchanged.

**Non-Goals:**

- No provisioner change. It already obeys the contract.
- No new flight state, and no new command surface.
- No re-key of old rows. An old row backfills its raw name from the canonical one.

## Decisions

- **Two names on one spec.** `StoreFlightSpec` gains `rawName` beside the canonical `name`. A single raw-only name was rejected: the flight key, the dedupe, and the graph lookups must stay spelling-blind, and each derives from `name`.
- **The raw name persists.** Both tables gain a nullable `raw_name` column, and the readers fall back to `name` when it is null. The fallback keeps an old row valid with no rebuild.
- **The dedupe stays canonical.** Two spellings of one identity still make one flight, and the first raw spelling wins the batch entry. The both-hit stop is the guard against a cross-ecosystem mix, and it arms correctly once the probes get the raw spelling.
- **The provisioner spec carries the raw name.** The report of the run echoes the spec string verbatim, thus the sender and the mapper stay in agreement through one builder function.

## Risks / Trade-offs

- [Two spellings of one identity race the raw slot] → The first enqueue wins. The identity is one flight either way, and the render then shows one true spelling of it.
- [An old failed row renders the canonical name] → The backfill copies `name` into `raw_name`, thus the render never reads null.

## Migration Plan

One additive migration: `raw_name TEXT` on `pending_store_adds` and `package_store_flights`, then one backfill `UPDATE` per table. A rollback drops nothing.

## Open Questions

None.
