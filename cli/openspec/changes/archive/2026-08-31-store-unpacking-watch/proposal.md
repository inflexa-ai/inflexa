# Proposal: store-unpacking-watch

## Why

A catalog download on Bun 1.3.10 froze inside the in-process zstd decompress of the first layer. The runtime lost the completion of the stream. The child then slept as `running` at a full meter, the row never moved again, and the sandbox gate held every sandbox-making action. The only exit was a kill by pid, found through `/proc`. The unpacking phase has no watch, no deadline, and no rendered state, thus a frozen child and a busy child read the same.

## What Changes

- The decompress of a layer runs under a liveness watch on decompressed bytes, with the two-minute window of the download watch.
- Each `tar` run gets a wall bound of `max(5 min, tarBytes / 1 MiB/s)` over the decompressed tar, because `tar` gives no byte signal.
- A fired watch settles the row as `failed`, with a message that names the layer and the phase. No new `TransferStatus` value.
- The transfers row gains a nullable `phase` column: `download`, then `unpacking`, and null for an image transfer.
- The unpacking phase heartbeats `updated_at` through a byte counter, on the 500 ms progress cadence.
- Three surfaces render the phase: the sidebar, `sandbox status`, and `store ls`. The full bar stays, the row word becomes `unpacking`, and the age tail follows.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `package-store-transfers`: the detached lifecycle gains the unpacking watch and its `failed` settle. The meter scenarios gain the unpacking phase, its heartbeat, and its tail on the sidebar, `sandbox status`, and `store ls`.

## Impact

- `src/modules/libs/store_download.ts`: the watch, the bound, the phase writes, and the heartbeat.
- `src/db/primary_migrations.ts` and the transfers row types: the `phase` column.
- `src/tui/layout/sidebar.tsx`, `src/modules/libs/pull.ts`, `store ls`, and the setup wizard: the tail render.
- `openspec/specs/package-store-transfers/spec.md`: the delta of this change.
- The word `unpacking` joins the `CONTEXT.md` glossary. `staging` stays with the farm swap and the analysis input root.
