# Tasks: store-add-raw-name

## 1. The row and the migration

- [x] 1.1 Migration: add the nullable `raw_name` column to `pending_store_adds` and `package_store_flights`, with a `name` backfill
- [x] 1.2 Carry `rawName` through `StoreFlightRow`, `PendingStoreAdd`, the queries, and the mutations, with a `COALESCE(raw_name, name)` read

## 2. The flight

- [x] 2.1 `StoreFlightSpec` gains `rawName`, and `makeStoreFlightSpec` keeps the trimmed user spelling beside the canonical identity
- [x] 2.2 The enqueue, the claim, the requeue, and the batch group carry the raw name, with the canonical dedupe unchanged
- [x] 2.3 `provisionerSpec` and `describeStoreFlightSpec` build from the raw name
- [x] 2.4 The refusal messages and the both-hit hint echo the raw spelling
- [x] 2.5 The retry of a failed flight re-enqueues the raw spelling, and the `link_packages` seam echoes the requested spelling

## 3. The renders

- [x] 3.1 The sidebar pipeline rows render the raw name
- [x] 3.2 `store ls` renders the raw name on the flight lines

## 4. The proofs

- [x] 4.1 Prove with a test that a flush of `GO.db --lang r` hands the provisioner `r:GO.db`
- [x] 4.2 Prove with a test that `GO.db` and `go.db` dedupe into one flight whose render shows `GO.db`
- [x] 4.3 Prove with a migration test that an old row backfills its raw name from the canonical one
