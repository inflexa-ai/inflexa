# Design: flight-refusals-and-debris

## Context

The two-phase flight works, and the smoke run proved it end to end. Three
gaps came out of the run. A detached refusal reports nowhere. Failed bytes
accumulate until a manual reclaim. A claim query failure reads as "joined".
The primary database is the one live channel a detached child can write:
the Bus is in-process only, and the prov chain takes one writer per
analysis.

## Goals / Non-Goals

**Goals:**

- One durable record per refused spec, readable by the user and the agent.
- Debris frees itself, with no user command and no user memory.
- A broken flight ledger surfaces as its own error.

**Non-Goals:**

- No push of the refusal into a running agent turn. The pull through
  `store ls` is the surface, and the prompt teaches it.
- No change to `store reclaim` semantics or to its approval gate.
- No new user command for debris.

## Decisions

1. **The failed row lives in `package_store_flights`.** The id is the
   normalized spec key, thus a retry claims the same row and the failure
   clears without a sweeper. Success rows still delete — a completed state
   that everyone has is noise. Migration 7 rebuilds the table with states
   `queued | running | failed` and a `message` column, and it copies the
   rows.
2. **The message records whole, and the surfaces bound the render.** The
   phase is `resolve`, `load_check`, or `commit`, and the full error text
   follows it. The row is the one durable copy after the debris pass
   collects the report file, thus record-time truncation would destroy the
   trace. The sidebar prints one line, and `store ls` prints a short head.
3. **Debris is the tier that nothing references.** A store directory is
   debris when no farm links it AND the graph holds no node for it. Stale
   acquire reports under `.inflexa-download/` are debris too. The
   provisioner gains `reclaim --debris`, which removes only that tier. Its
   spec rule lands in the harness tree at sync.
4. **Two debris triggers, both silent, and no timer.** The tail of a flush
   that ended with refusals, and one boot pass of the app after the runtime
   reaches ready. The tail frees the fresh refusals at once, and the boot
   pass sweeps what a crashed session left. Both wait for no live work,
   take the reclaim lock briefly, and log only when they free something.
   Flight-end deletion stays out: a sibling flight can pool-hit a fresh
   directory, and only the exclusivity window makes deletion race-free.
5. **A claim error is a refusal.** `claimStoreFlight` failures map to a
   `refused` outcome that names the ledger problem. Only a real live row
   reads as "joined".

## Risks / Trade-offs

- A failed row can outlive its relevance when the user never retries. The
  cost is one line in `store ls`, and the next flush of the same spec
  clears it.
- The idle debris pass takes the reclaim lock, thus it can delay a flight
  start by its short window. The pass yields when any work is live.
- The migration rebuilds a table that a live holder in another process can
  write. The old states are a subset of the new CHECK, thus the writes of
  an old child stay valid. Task 1.3 proves the concurrent behavior with a
  test, or it records the bound.
