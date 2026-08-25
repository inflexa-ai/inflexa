# Tasks: flight-refusals-and-debris

## 1. The database

- [x] 1.1 Migration 7: rebuild `package_store_flights` with the states `queued | running | failed` and a `message` column, and copy the rows
- [x] 1.2 Add the mutations and queries: settle a flight as `failed` with the message, flip a `failed` row to `queued` on a claim, and list the failed rows
- [x] 1.3 Prove the migration beside a live second connection with a test, or record the bound in the design

## 2. The flight

- [x] 2.1 The flush settles each refused spec as a `failed` row: the phase, then the whole error text, with no record-time truncation
- [x] 2.2 Map a flight-claim query failure to its own refusal outcome, and keep "joined" for a real live row

## 3. Debris

- [x] 3.1 `provision.py`: add `reclaim --debris` — remove only the store directories with no farm link and no graph node, plus the stale acquire reports
- [x] 3.2 Add the two silent triggers: the tail of a flush that ended with refusals, and the idle pass when no work is live
- [x] 3.3 Record the debris rule in the provisioner spec of the harness tree at sync

## 4. The surfaces

- [x] 4.1 `store ls`: add the failed-flights section, with a short head of each reason
- [x] 4.2 The sidebar keeps one failure line per failed flight, and the line clears when the row clears
- [x] 4.3 THE PACKAGE FLOW prompt: direct the agent to read `store ls` before a second ask for a missing package

## 5. Tests and verification

- [x] 5.1 Unit tests: the failed-row lifecycle, the claim-error refusal, the debris tier boundary, and the yield to live work
- [x] 5.2 Run `bun run typecheck`, `bun run lint`, `bun run test`, and the provisioner unittest suite
