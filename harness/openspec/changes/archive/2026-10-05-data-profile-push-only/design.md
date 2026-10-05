## Context

Three implementations of "did the input set change?" existed, and they disagreed:

| | `inputSignature` | `inputFiles` | `inputFileIds` |
|-|-|-|-|
| `app/data-profile-policy.ts` | yes | no — reads as drift | yes |
| CLI `isProfiledAtParity` | yes | yes | no — reads as drift |
| Cortex (via the policy, no signature) | count only | count only | identity |

Each treated the other's legacy comparand as "no comparand", so the same row drew opposite
verdicts depending on who asked. Unifying them was the obvious repair, and it is the wrong
one: it would make a decision cheaper to compute that should not be computed here at all.

## Goals / Non-Goals

- **Goal**: one place decides a re-profile — the party that changed the inputs.
- **Goal**: the harness reports what a row states, and infers nothing about the world outside it.
- **Non-Goal**: detecting an in-place content edit. No party in the system can do this reliably
  for storage it does not own, and provenance already records what each step actually read.
- **Non-Goal**: removing the recorded comparand. It is an audit record, not a decision input.

## Decisions

### The staleness predicate is deleted rather than narrowed

A narrowed predicate — comparing declared id sets, say — would be correct and still wrong to
have. It answers "do two of my own writes agree?", which is a question about this service's
consistency, not about the data. Keeping it would preserve the shape of a read-path re-trigger
and invite the next caller to lean on it.

### `stale` survives as a lifecycle state, with a narrower cause

`inspect_data_profile` keeps `state: "stale"` and `staleReason`. Both remain reachable, because
`tryRerun` / `tryRetry` preserve `data_profile_result` on purpose: a row can carry a prior
profile while the next attempt runs or after it fails, and saying so is reporting the row, not
inferring past it. Only the "the input set changed" reason goes.

This keeps the tool's own standing rule — it must not advertise a distinction the implementation
cannot produce — which the removed reason had come to violate.

### The recorded comparand stays written

`inputSignature` costs one hash over the staged manifest at profile completion. Nothing reads it
after this change. It is kept because it is the only durable answer to "which files did this
profile cover?", it is cheap, and its absence is unrecoverable after the fact — whereas a reader
can be added back at any time.

`inputFileIds` and `inputFiles` remain readable on older rows and are not re-introduced.

## Risks / Trade-offs

- **A failed push is now unrepaired.** The read check silently covered one reachable case: Cortex's
  seed route upserts `seed_input_file_ids`, then triggers, then returns 200 with the trigger outcome
  in the body — and Nexus's `AnalysisSeedWorker` checks only the HTTP error, so a failed trigger is a
  successful job that River never retries. Push-only makes the push the sole delivery path, so that
  outcome must become a job failure. Fixed embedder-side, where the delivery guarantee lives.
- **An in-place edit goes unnoticed.** Accepted, and narrower than it sounds: `appendInputUsed` records
  `(path, hash)` with the hash read from disk at step reconcile time, so an edited input mints a
  different entity and every prior artifact's `used` edge still names the bytes it actually consumed.
- **No manual re-profile exists in the managed service.** `POST .../data-profile/retry` claims `failed`
  rows only; a completed profile cannot be re-run on request. The CLI has `forceReprofile`. Out of scope
  here, and named so it is not discovered as a surprise.
