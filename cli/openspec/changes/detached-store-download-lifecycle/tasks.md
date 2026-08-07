## 1. The download row

- [ ] 1.1 Add the persisted shape to `src/types/lib_store_download.ts`: the five states, the byte totals, the layer totals, the manifest digest, the message, and the holder pid
- [ ] 1.2 Add a `lib_store_downloads` table in a new migration of `src/db/primary_migrations.ts`. Order the columns as identity, then core data, then foreign keys
- [ ] 1.3 Add the read of the one row to `src/db/primary_query.ts`. An absent row gives `null` on the ok channel, never an error
- [ ] 1.4 Add the writes to `src/db/primary_mutation.ts`: the start of a run, the progress, and each terminal state
- [ ] 1.5 Depend on the WAL mode that `src/db/primary.ts:17` sets, and on the busy timeout at `:19`. Add no second connection and no new pragma
- [ ] 1.6 Read nothing from the row yet. This step lands alone, per step 1 of the Migration Plan

## 2. The lock hold and the read-only probe

- [ ] 2.1 Add a read-only probe beside `acquireInstanceLock` in `src/lib/lock.ts:76`. It reuses `instanceLockPath` at `:38` and the pid test at `:60`
- [ ] 2.2 Make sure that the probe takes no lock. A reader that took the lock would refuse the next real downloader
- [ ] 2.3 Hold the key `lib-store-download` for the whole life of the download process, and release it on each exit path
- [ ] 2.4 Read a row of `running` with no live holder as `failed`. Add no heartbeat, no stale threshold, and no wall-clock timeout

## 3. `inflexa store download`

- [ ] 3.1 Add the detached start to `src/modules/libs/store_download.ts`, with the `Bun.spawn(...).unref()` pattern of `src/lib/open_external.ts:69`
- [ ] 3.2 Write the progress row from the transfer. `downloadLibStore` already carries a progress observer, thus the writes ride it
- [ ] 3.3 Write a readable message on a failure. It names the fault and the remedy, and it is not a stack trace
- [ ] 3.4 Add `runStoreDownload` to `src/modules/libs/store.ts`, beside `runStoreLs` and `runStoreUse`. It starts a run, or it reports the live run
- [ ] 3.5 Report the store as up to date when the receipt pins the current manifest and `--force` is absent. Start no process then
- [ ] 3.6 Register `store download` in `src/cli/index.ts`, in the `store` family at `:802`, with the `approval` policy. Name `--force` in the description
- [ ] 3.7 Name, in the output of the command, the command that reports the progress. The detached process writes nothing to the terminal of the starter

## 4. The setup trigger

- [ ] 4.1 Start the detached downloader from `runSandboxImageSetup` in `src/modules/infra/setup.ts:684`, after the two image pulls
- [ ] 4.2 Take the consent from the `--sandbox` answer. Setup asks no second question about size
- [ ] 4.3 Record `declined` when the user answers no in an interactive run
- [ ] 4.4 Exit setup without a wait for the transfer, and name the command that reports the progress
- [ ] 4.5 Start no second process when the lock is held. Report the live run instead

## 5. The progress readouts

- [ ] 5.1 Read the row in `src/tui/hooks/sandbox_gate.tsx`, and give the state to `LibStoreGateState` at `:50`
- [ ] 5.2 Report the transfer in `src/tui/layout/sidebar.tsx`: the state, and the running byte total
- [ ] 5.3 Report the download state in `inspectStore` (`src/modules/libs/store.ts:338`), and render it in `runStoreLs` at `:639`
- [ ] 5.4 Say that no download ran when the row is absent. A store can arrive by a route that wrote no row
- [ ] 5.5 Keep `store ls` at the `auto` policy, and add no option to it

## 6. Retire the app-open trigger, and free the boot

- [ ] 6.1 Remove `startLibStoreDownload` from `src/tui/hooks/sandbox_gate.tsx:334`
- [ ] 6.2 Remove the call at `src/tui/app.launch.tsx:90`, and its comment about the store opt-in
- [ ] 6.3 Remove the app-open consent from the gate. The gate reads the row, and it names `inflexa store download` as the retry
- [ ] 6.4 Refuse a sandbox action when the state is `declined`, and name the retry. Open no consent
- [ ] 6.5 Stop the `lib_store_unusable` return at `src/modules/harness/runtime.ts:645`. An unreadable store inventory no longer fails the boot
- [ ] 6.6 Make sure that `src/tui/hooks/boot.ts:81` no longer reaches `phase: "failed"` for the store, thus `src/tui/app.tsx:962` reads `ready` as true
- [ ] 6.7 Keep the refusal of the gate at `src/tui/hooks/sandbox_gate.tsx:195-206`. One refusal sits in one place
- [ ] 6.8 Keep the refusal of `inflexa profile` and `inflexa run`, because each one makes a sandbox at once
- [ ] 6.9 Land this section last. It is the step that changes what a user sees

## 7. Specs

- [ ] 7.1 Apply the `lib-store-download-process` delta: the detached process, the five states, the row, the receipt split, the lock liveness, the single-flight rule, and the command
- [ ] 7.2 Apply the `lib-store-download` delta: the trigger at `inflexa setup`, and the gate that reads the process state
- [ ] 7.3 Apply the `lib-store-provisioning` delta: an unreadable inventory refuses each sandbox action and fails no boot
- [ ] 7.4 Apply the `package-store-management` delta: `inflexa store download`, and the download state in the inspection
- [ ] 7.5 Apply the `setup-answers` delta: the `--sandbox` answer covers the catalog, and setup starts the downloader
- [ ] 7.6 Reconcile `mandatory-store-and-farm-switch`, which owns the app-open trigger today. Its delta, its design, and its tasks each point at this change

## 8. Verification

- [ ] 8.1 Do a test that the transfer continues after `inflexa setup` exits
- [ ] 8.2 Do a test that the transfer continues after the user quits the app
- [ ] 8.3 Do a test that the app opens with no store and starts no process
- [ ] 8.4 Do a test of each permitted transition, and of the two terminal states that only a retry leaves
- [ ] 8.5 Do a test that a second process reads the row while the writer writes it
- [ ] 8.6 Do a test that a row of `running` with a dead holder reads as `failed`
- [ ] 8.7 Do a test that the probe leaves the lock with its live holder
- [ ] 8.8 Do a test that a second start finds the lock held, starts no process, and reports the live run
- [ ] 8.9 Do a test that a store with a valid receipt and no row is usable
- [ ] 8.10 Do a test that a row of `installed` with no receipt does not make the store usable
- [ ] 8.11 Do a test that an unreadable store inventory boots the runtime, and that chat answers
- [ ] 8.12 Do a test that the same inventory refuses each sandbox action, with the remedy and a retry
- [ ] 8.13 Do a test that `store download` starts nothing over a current receipt, and that `--force` starts a transfer
- [ ] 8.14 Do a test that `store ls` reports the state and the byte totals, and that it prompts for nothing
- [ ] 8.15 Update the agent policy snapshot in `src/cli/agent_policy_tree.test.ts` for the new `store download` grant
- [ ] 8.16 Remove the `startLibStoreDownload` tests at `src/tui/hooks/sandbox_gate.test.ts:242`, and add the tests of the row reader
- [ ] 8.17 Run `bun run typecheck`, `bun run lint`, and `bun run test`. Then run `bun run format:file` on each changed file under `src/`

## 9. Open decisions

- [ ] 9.1 BLOCKED — does the sidebar report the transfer as a bar, or as a line of text? The design gallery owns that answer. Consult `src/tui/layout/design_gallery.tsx` and ask the user before you add a surface
- [ ] 9.2 BLOCKED — what happens when a user starts a second `inflexa setup` while the app runs? The lock refuses the second start, and the second setup reports the live run. Confirm that this is the wanted behavior
