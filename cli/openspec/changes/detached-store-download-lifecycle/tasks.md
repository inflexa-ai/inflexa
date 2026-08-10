## 1. The download row

- [x] 1.1 Add the persisted shape to `src/modules/libs/`: the six states, the byte totals, the layer totals, the manifest digest, the message, and the holder pid. It has one consumer, thus it colocates with the module and it does not go in `src/types/`
- [x] 1.2 Add a `lib_store_downloads` table in a new migration of `src/db/primary_migrations.ts`. Order the columns as identity, then core data, then foreign keys
- [x] 1.3 Add the read of the one row to `src/db/primary_query.ts`. An absent row gives `null` on the ok channel, never an error
- [x] 1.4 Add the writes to `src/db/primary_mutation.ts`: the start of a run, the progress, and each terminal state
- [x] 1.5 Depend on the WAL mode that `src/db/primary.ts:17` sets, and on the busy timeout at `:19`. Add no second connection and no new pragma
- [x] 1.6 Read nothing from the row yet. This step lands alone, per step 1 of the Migration Plan

## 2. The lock hold and the read-only probe

- [x] 2.1 Add a read-only probe beside `acquireInstanceLock` in `src/lib/lock.ts:76`. It reuses `instanceLockPath` at `:38` and the pid test at `:60`
- [x] 2.2 Make sure that the probe takes no lock. A reader that took the lock would refuse the next real downloader
- [x] 2.3 Hold the key `lib-store-download` for the whole life of the download process, and release it on each exit path
- [x] 2.4 Read a row of `running` with no live holder as `failed`. Add no heartbeat, no stale threshold, and no wall-clock timeout
- [x] 2.5 Refuse `inflexa store add` while a download is live, exactly as `storeUse` refuses. The merge moves the staged tree into the store root one child at a time, thus a concurrent provisioning run can meet a half-merged root
- [x] 2.6 Name the live download and the command that reports the progress in that refusal. Write nothing to the store root. A dead holder reads as `failed`, thus it refuses nothing

## 3. `inflexa store download`

- [x] 3.1 Add the detached start to `src/modules/libs/store_download.ts`, with the `Bun.spawn(...).unref()` pattern of `src/lib/open_external.ts:69`
- [x] 3.2 Write the progress row from the transfer. `downloadLibStore` already carries a progress observer, thus the writes ride it
- [x] 3.3 Write a readable message on a failure. It names the fault and the remedy, and it is not a stack trace
- [x] 3.4 Add `runStoreDownload` to `src/modules/libs/store.ts`, beside `runStoreLs` and `runStoreUse`. It starts a run, or it reports the live run
- [x] 3.5 Report the store as up to date when the receipt pins the current manifest and `--update` is absent. Start no process then
- [x] 3.6 Report an available update when the receipt pins a different manifest and `--update` is absent. Transfer nothing then, per `store_download.ts:660-663`
- [x] 3.7 Pass `deps.force` (`store_download.ts:172-174`) when the user gives `--update`. The flag is the consent to apply a moved tag, and it is not a way to transfer a healthy store a second time
- [x] 3.8 Register `store download` in `src/cli/index.ts`, in the `store` family at `:802`, with the `approval` policy. Name `--update` in the description, and say what it consents to
- [x] 3.9 Name, in the output of the command, the command that reports the progress. The detached process writes nothing to the terminal of the starter
- [x] 3.10 Name the bytes necessary and the bytes available in the message when the disk exhausts. A bare "no space left" tells a user nothing about how much disk to free
- [x] 3.11 Remove the partial transfer on that failure. `store_download.ts:523` and `:535` already drop the staged tree. Keep that path, and make sure that the store root holds what it held before the run
- [x] 3.12 Write the total bytes and the total layers one time, when the manifest resolves. `LibStoreLayer.size` (`store_download.ts:82`) declares each layer size, thus the total is exact and it never grows
- [x] 3.13 Leave the two totals absent before the manifest resolves. Write no estimate, and do not copy the growing-estimate approach of the reference store
- [x] 3.14 Keep `--update` a flag on this command. The flag and the base command both write the store root, thus one `approval` policy covers the two

## 4. `inflexa store cancel` and `inflexa sandbox remove`

- [x] 4.1 Add `runStoreCancel` to `src/modules/libs/store.ts`, beside `runStoreDownload`. It stops the live transfer through the holder pid of the row
- [x] 4.2 Record `canceled` from the cancel, and remove the partial staged tree. Reuse the drop path at `store_download.ts:523` and `:535`
- [x] 4.3 Remove no installed content. Each child that the store root holds stays where it is
- [x] 4.4 Report that no run is live when the lock has no holder. Write no row, remove no tree, and stop no process
- [x] 4.5 Register `store cancel` in `src/cli/index.ts`, in the `store` family at `:802`, with the `blocked` policy. The reason is that the cancel throws away a transfer that is part done
- [x] 4.6 Keep the cancel a subcommand. `AgentPolicy` (`src/cli/agent_policy.ts:19-20`) binds one policy to one command, thus a flag cannot carry a `blocked` policy of its own
- [x] 4.7 Add `sandboxRemove` to `src/modules/libs/pull.ts`, beside `sandboxPull` and `sandboxStatus`. It removes the runtime image and the provisioner image
- [x] 4.8 Report each image that the command removed, and report each image that was absent already. An absent image refuses nothing
- [x] 4.9 Touch no store and no farm. The two images and the package catalog are separate artifacts
- [x] 4.10 Register `sandbox remove` in `src/cli/index.ts`, in the `sandbox` family at `:747`, with the `blocked` policy. The reason is that the removal destroys a multi-gigabyte artifact that a user waited for

## 5. The setup trigger

- [x] 5.1 Start the detached downloader from `runSandboxImageSetup` in `src/modules/infra/setup.ts:684`, when setup starts the two image pulls. The process is detached, thus the catalog transfers while the images pull
- [x] 5.2 Take the consent from the `--sandbox` answer. That answer covers one bundle: the runtime image, the provisioner image, and the catalog. Setup asks no second question about size
- [x] 5.3 Record `declined` when the user answers no in an interactive run
- [x] 5.4 Exit setup when the image pulls finish. Do not wait for the catalog, and name the command that reports the progress
- [x] 5.5 Start no second process when the lock is held. Report the live run instead
- [x] 5.6 Open no consent at the store step of a second setup. The first answer stands
- [x] 5.7 Report the live transfer at that step: the state, the bytes transferred, and the total bytes
- [x] 5.8 Name `inflexa store cancel` and `inflexa sandbox remove` at that step. Open no prompt for either one
- [x] 5.9 Continue to the remaining steps of setup. A live transfer blocks the references, the database, and the model configuration in no way

## 6. The progress readouts

- [x] 6.1 Read the row in `src/tui/hooks/sandbox_gate.tsx`, and give the state to `LibStoreGateState` at `:50`
- [x] 6.2 Report the transfer in `src/tui/layout/sidebar.tsx`: the state, the running byte total, and the meter. Use `GLYPHS.bar` (`src/lib/design_system.ts:53`, U+25AE), with the filled cells in the `success` role and the empty cells in the `fgSubtle` role
- [x] 6.3 Render no meter before the manifest resolves. The totals are absent then, thus report the resolve step instead
- [x] 6.4 Keep the meter out of the gate hold text. The sidebar owns the figure, per the rule at `src/tui/components/run_card_block.tsx:68-69`
- [x] 6.5 Report the download state in `inspectStore` (`src/modules/libs/store.ts:338`), and render it in `runStoreLs` at `:639`
- [x] 6.6 Report an available update in the listing and in the sidebar, and name `inflexa store download --update`. Open no prompt on either surface
- [x] 6.7 Say that no download ran when the row is absent. A store can arrive by a route that wrote no row
- [x] 6.8 Say that the user stopped the transfer when the state is `canceled`, and name `inflexa store download` as the retry
- [x] 6.9 Keep `store ls` at the `auto` policy, and add no option to it. It is the readout that the conversation agent reads with no approval

## 7. Retire the app-open trigger, and free the boot

- [x] 7.1 Remove `startLibStoreDownload` from `src/tui/hooks/sandbox_gate.tsx:334`
- [x] 7.2 Remove the call at `src/tui/app.launch.tsx:90`, and its comment about the store opt-in
- [x] 7.3 Remove the app-open consent from the gate. The gate reads the row, and it names `inflexa store download` as the retry
- [x] 7.4 Refuse a sandbox action when the state is `declined` or `canceled`, and name the retry. Open no consent for either state
- [x] 7.5 Stop the `lib_store_unusable` return at `src/modules/harness/runtime.ts:645`. An unreadable store inventory no longer fails the boot
- [x] 7.6 Make sure that `src/tui/hooks/boot.ts:81` no longer reaches `phase: "failed"` for the store, thus `src/tui/app.tsx:962` reads `ready` as true
- [x] 7.7 Keep the refusal of the gate at `src/tui/hooks/sandbox_gate.tsx:195-206`. One refusal sits in one place
- [x] 7.8 Keep the refusal of `inflexa profile` and `inflexa run`, because each one makes a sandbox at once
- [x] 7.9 Land this section last. It is the step that changes what a user sees

## 8. Specs

- [x] 8.1 Apply the `lib-store-download-process` delta: the detached process, the six states, the row, the receipt split, the lock liveness, the single-flight rule, the download command, and the cancel command
- [x] 8.2 Apply the `lib-store-download` delta: the trigger at `inflexa setup`, the gate that reads the process state, and the gate treatment of `canceled`
- [x] 8.3 Apply the `lib-store-provisioning` delta: an unreadable inventory refuses each sandbox action and fails no boot, and `inflexa sandbox remove` joins the image surface
- [x] 8.4 Apply the `package-store-management` delta: `inflexa store download`, `inflexa store cancel`, and the download state in the inspection
- [x] 8.5 Apply the `setup-answers` delta: the `--sandbox` answer covers the catalog, setup starts the downloader, and a second setup blocks no step
- [x] 8.6 Reconcile `mandatory-store-and-farm-switch`, which owns the app-open trigger today. Its delta, its design, and its tasks each point at this change

## 9. Verification

- [ ] 9.1 Do a test that the transfer continues after `inflexa setup` exits
- [ ] 9.2 Do a test that the transfer continues after the user quits the app
- [x] 9.3 Do a test that the app opens with no store and starts no process
- [x] 9.4 Do a test of each permitted transition, and of the three terminal states that only a retry leaves
- [x] 9.5 Do a test that a second process reads the row while the writer writes it
- [x] 9.6 Do a test that a row of `running` with a dead holder reads as `failed`
- [x] 9.7 Do a test that the probe leaves the lock with its live holder
- [x] 9.8 Do a test that a second start finds the lock held, starts no process, and reports the live run
- [x] 9.9 Do a test that a store with a valid receipt and no row is usable
- [x] 9.10 Do a test that a row of `installed` with no receipt does not make the store usable
- [x] 9.11 Do a test that an unreadable store inventory boots the runtime, and that chat answers
- [x] 9.12 Do a test that the same inventory refuses each sandbox action, with the remedy and a retry
- [x] 9.13 Do a test that `store download` starts nothing over a receipt that pins the current manifest, with and without `--update`
- [x] 9.14 Do a test that a receipt which pins a different manifest reports an available update and transfers nothing, and that `--update` then starts the transfer
- [x] 9.15 Do a test that `store ls` reports the state and the byte totals, and that it prompts for nothing
- [x] 9.16 Do a test that `store ls` and the sidebar report an available update and name `inflexa store download --update`, and that neither opens a prompt
- [x] 9.17 Do a test that the gate releases the hold when the row reads `installed` and the receipt validates
- [x] 9.18 Do a test that `inflexa store add` refuses while a download is live, and that it writes nothing to the store root
- [x] 9.19 Do a test that `inflexa store add` runs when the row reads `running` and the holder is gone
- [x] 9.20 Do a test that an exhausted disk names the bytes necessary and the bytes available, and that it leaves no staged tree
- [x] 9.21 Do a test that the two totals hold the values of the manifest, and that neither total grows during the transfer
- [x] 9.22 Do a test that the sidebar renders the meter, and that the gate hold text carries no meter and no percentage
- [x] 9.23 Do a test that `store cancel` stops a live run, records `canceled`, and removes the partial staged tree
- [x] 9.24 Do a test that `store cancel` removes no installed content from the store root
- [x] 9.25 Do a test that `store cancel` reports the absence of a live run and changes nothing
- [x] 9.26 Do a test that a state of `canceled` refuses each sandbox action, names the retry, and opens no consent
- [x] 9.27 Do a test that `store download` after a cancel moves the state to `pending`, then to `running`
- [x] 9.28 Do a test that `sandbox remove` removes the two images and names each one
- [x] 9.29 Do a test that `sandbox remove` reports an absent image and does not fail
- [x] 9.30 Do a test that `sandbox remove` leaves the store root and each farm unchanged
- [x] 9.31 Do a test that a second `inflexa setup` opens no consent, reports the live transfer, and starts no process
- [x] 9.32 Do a test that a second `inflexa setup` names `inflexa store cancel` and `inflexa sandbox remove`
- [x] 9.33 Do a test that a live transfer blocks no other step of setup, and that setup exits
- [x] 9.34 Update the agent policy snapshot in `src/cli/agent_policy_tree.test.ts` for the three new grants: `store download` at `approval`, and `store cancel` and `sandbox remove` at `blocked`
- [x] 9.35 Do a test that each `blocked` grant carries its reason string
- [x] 9.36 Remove the `startLibStoreDownload` tests at `src/tui/hooks/sandbox_gate.test.ts:242`, and add the tests of the row reader
- [x] 9.37 Run `bun run typecheck`, `bun run lint`, and `bun run test`. Then run `bun run format:file` on each changed file under `src/`

## 10. Open decisions

- [x] 10.1 RESOLVED — the sidebar reports the transfer with the run meter. The glyph is `GLYPHS.bar` (`src/lib/design_system.ts:53`, U+25AE), the filled cells take the `success` role, and the empty cells take the `fgSubtle` role. The gate hold text stays bare, because two surfaces must not show one figure — refer to `src/tui/components/run_card_block.tsx:68-69`
- [x] 10.2 RESOLVED — a second `inflexa setup` never blocks. Its store step opens no consent, reports the live transfer, names `inflexa store cancel` and `inflexa sandbox remove`, and continues to the remaining steps. The lock refuses a second downloader
- [x] 10.3 RESOLVED — `inflexa store cancel` and `inflexa sandbox remove` each take the `blocked` policy. The reason of the cancel is that it throws away a transfer that is part done. The reason of the removal is that it destroys a multi-gigabyte artifact that a user waited for
