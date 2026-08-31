# Tasks: store-unpacking-watch

## 1. The row and the migration

- [x] 1.1 Add the nullable `phase` column to the transfers table in `src/db/primary_migrations.ts`
- [x] 1.2 Carry `phase` through `TransferRow`, the queries, and the mutations, with `download` and `unpacking` as the values
- [x] 1.3 Extend `recordTransferProgress` so a write can set the phase and the heartbeat together

## 2. The watch and the bound

- [x] 2.1 Put a byte counter between the decompressor and the tar write in `extractLayer`, and feed a liveness watch with the two-minute window
- [x] 2.2 Bound each `runTar` call with `max(5 min, tarBytes / 1 MiB/s)` over the decompressed tar, and kill the `tar` child when the bound fires
- [x] 2.3 Settle a fired watch as `failed` with a message that names the layer and the phase
- [x] 2.4 Write `phase = "unpacking"` at the start of `stageAndMerge`, and heartbeat `updated_at` from the byte counter on the progress cadence

## 3. The render

- [x] 3.1 Sidebar: at a full bar with `phase = "unpacking"`, show the tail `unpacking` with the age of the last write
- [x] 3.2 `sandbox status` and `store ls`: render the phase and the age on the running line
- [x] 3.3 Setup screen: apply the same rule as the sidebar (no code: the wizard prints no transfer row, and it points at `sandbox status`)

## 4. The tests and the words

- [x] 4.1 Prove with a test that a stopped decompress settles as `failed` at the window, and that the lock frees
- [x] 4.2 Prove with a test that a hung `tar` run settles as `failed` at its bound
- [x] 4.3 Prove with a test that the unpacking heartbeat moves `updated_at`, and that an image row keeps a null phase
- [x] 4.4 Prove with a render test that the full bar shows the `unpacking` tail, in the sidebar snapshot
