# Design: store-unpacking-watch

## Context

The catalog child downloads the layers, and then it unpacks them: an in-process zstd decompress into a temporary tar, a `tar -x`, and a member audit. The download runs under a liveness watch (`src/lib/download.ts:97`), but the unpacking runs under nothing. The last row write is the last byte, thus the meter freezes at full while the unpacking works — or while it hangs.

A Bun 1.3.10 runtime fault proved the second case: the pipeline promise lost its completion, and the child slept as `running` for an hour. The sandbox gate waits on transfer liveness, thus the frozen child also blocked every sandbox.

## Goals / Non-Goals

**Goals:**

- A frozen unpacking settles itself as `failed` within a bounded time.
- A busy unpacking reads as alive on every surface.

**Non-Goals:**

- No new `TransferStatus` value.
- No change to the image transfers. Their rows keep a null phase.
- No progress meter inside one `tar` run. `tar` gives no byte signal.

## Decisions

- **A liveness watch on the decompress, not a wall clock.** A byte counter between the decompressor and the file write feeds the watch. Two quiet minutes mean a dead stream. The window reuses the value of `LIVENESS_WINDOW_MS`, because the two watches state one rule. A wall clock was rejected: unpacking time scales with the store and the disk.
- **A wall bound for each `tar` run: `max(5 min, tarBytes / 1 MiB/s)`, over the decompressed tar.** The floor answers the small layer, and the rate answers the large one. The base is the inflated size, because the work of `tar` scales with it and not with the compressed layer. A flat bound was rejected as too tight or too loose at the ends.
- **The fired watch settles `failed` with a message.** The message names the layer and the phase. The spec already reads a dead `running` as `failed`, and the retry hints exist for `failed` only.
- **A nullable `phase` column on the transfers row.** Values: `download`, `unpacking`, null. A reuse of `message` was rejected, because that field carries the failure text. A heartbeat without a phase word was rejected, because the surfaces then cannot name the wait.
- **The heartbeat rides the byte counter.** The counter calls the progress write on the 500 ms cadence, thus `updated_at` moves for the whole phase.
- **The render keeps the full bar.** The bar states that the bytes arrived. The row word becomes `unpacking`, and the age tail follows, on the sidebar, `sandbox status`, and `store ls`. The setup wizard renders no transfer row: it points at `sandbox status`.
- **The phase word is `unpacking`.** `staging` already names the farm swap and the analysis input root. A third meaning was rejected.

## Risks / Trade-offs

- [The rate floor of the `tar` bound is generous] → A hung `tar` over a 4 GiB decompressed tar holds the gate for about 68 minutes. The hold is finite, visible, and rare.
- [A slow machine under load can trip the two-minute watch] → The watch reads forward motion, not speed. Only a full stop of two minutes fires it.
- [The migration adds a column to a hot row] → The column is nullable with a null default, thus old rows and image rows stay valid.

## Migration Plan

One additive migration: the `phase` column, nullable, no backfill. A rollback drops nothing, because every reader treats null as "no phase known".

## Open Questions

None. The grill of 2026-08-31 settled the eight decisions above.
