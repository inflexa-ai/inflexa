## 1. The image constants

- [x] 1.1 In `src/modules/libs/images.ts`, add the provisioner image constant beside `GHCR_NAMESPACE`, and add the one sandbox image constant
- [x] 1.2 Remove `SANDBOX_VARIANTS`, `SandboxVariant`, `VARIANT_LABELS`, `VARIANT_DESCRIPTIONS`, `variantImage`, `parseVariant`, and `variantOfImage`
- [x] 1.3 Correct the module docstring of `images.ts`, which says the store is baked into the pulled image
- [x] 1.4 Update each importer of the removed names: `src/modules/libs/pull.ts`, `src/modules/harness/config.ts`, and `src/tui/hooks/sandbox_gate.tsx`

## 2. Pull the provisioner at setup

- [x] 2.1 Pull the provisioner image in `src/modules/infra/setup.ts`, through the same handler and the same runtime as the sandbox image
- [x] 2.2 Report the provisioner image in `inflexa sandbox status`, beside the sandbox image
- [x] 2.3 In `src/modules/libs/store.ts`, pull the provisioner image when it is absent, instead of the `image_unconfigured` error at `:129-134`
- [x] 2.4 Remove the `image_unconfigured` variant of `ProvisionError`, and the `image` parameter that carries the configured reference

## 3. Remove the store opt-in

- [x] 3.1 Remove the `libStore` key and the `provisionerImage` key from `harnessConfigSchema` in `src/modules/harness/config.ts`
- [x] 3.2 Remove `resolveLibStore`, `resolveProvisionerImage`, and the `LibStoreLocation` type, and give the store root directly from `env.libStoreDir`
- [x] 3.3 Report a removed key one time when a configuration file still carries it, so a user can clean the file
- [x] 3.4 In `src/modules/harness/runtime.ts`, pass the store root as `libStorePath` for every sandbox
- [x] 3.5 Remove the `disabled` phase from `LibStoreGateState` in `src/tui/hooks/sandbox_gate.tsx`, and the branches that set it
- [x] 3.6 SUPERSEDED by `detached-store-download-lifecycle` — Start the download in `startLibStoreDownload` with no switch test. The code stands. That change retires `startLibStoreDownload` and starts the download from `inflexa setup`
- [x] 3.7 PART SUPERSEDED by `detached-store-download-lifecycle` — Report the gate phase in the status surface while the gate holds. The open consent goes, because setup owns the consent. The byte total and the failure message stay, and both come from the download row

## 4. The inventory failure mode

- [x] 4.1 In `src/modules/harness/runtime.ts:678-695`, remove the fall back to the image label cache
- [x] 4.2 DEFECT, SUPERSEDED by `detached-store-download-lifecycle` — Report an unreadable store inventory as a boot failure that names the store and the remedy. The code stands, and it is wrong. A boot failure drops each chat submit, thus it kills chat on the machine where the download is most necessary. It also contradicts the `lib-store-provisioning` delta of this change, which says that an unreadable inventory "SHALL let the sandbox gate refuse the action". Task 4.3 is the correct refusal, and one refusal sits in one place
- [x] 4.3 Make the sandbox gate refuse an action when the inventory is unreadable, with the remedy and a retry
- [x] 4.4 Remove `partialLibStoreRoot` and the warning that names the image label cache, if nothing else reads them

## 5. `inflexa store use <farm>`

- [x] 5.1 Add `storeUse` to `src/modules/libs/store.ts`: it makes the link at a temporary name in the store root, then renames it over `current`
- [x] 5.2 Refuse when `acquireInstanceLock` reports the `harness-runtime` key held. Add `--force` for a stale lock, and name the risk to a live sandbox before the write
- [x] 5.3 Refuse when `inspectLibStoreDownload` reports `incomplete`
- [x] 5.4 Refuse a farm that is absent, and a farm that is not a directory with `packages.txt` and `meta.json`, which is the shape `libStoreUsable` applies
- [x] 5.5 Refuse a dot-prefixed farm name, which marks staging or superseded debris
- [x] 5.6 Apply `--force` to the live-runtime refusal only. The absent-farm refusal, the incomplete-farm refusal, the in-flight-download refusal, and the dot-prefix refusal each run under `--force` too
- [x] 5.7 Register `store use` in `src/cli/index.ts` with the `approval` policy, and name `--force` in its description. State in the description that `--force` covers a stale runtime lock only
- [x] 5.8 Add no merge option, and record the reason in the module docstring

## 6. `inflexa store ls` and the download report

- [x] 6.1 Report in `inspectStore` whether `current` resolves to a farm, and name the command that switches when it does not
- [x] 6.2 Read the track set of each farm from its `meta.json`, and report it beside the link count
- [x] 6.3 Keep `store ls` at the `auto` policy, and add no flag to it
- [x] 6.4 After a download whose outcome reports `farmsAdded` and `currentSet` false, name the added farm and `inflexa store use <farm>`

## 7. Remove the variant surface

- [x] 7.1 Remove the variant argument and the interactive variant prompt from `src/modules/libs/pull.ts`
- [x] 7.2 Report a clear error when `inflexa sandbox pull` receives an argument
- [x] 7.3 Remove the variant question from `src/modules/infra/setup.ts`
- [x] 7.4 Fail validation for a `--sandbox` answer that names a retired variant, in the one up-front pass, naming both spellings
- [x] 7.5 Update the command descriptions in `src/cli/index.ts`, so `bun run docs:gen` emits the new surface

## 8. Specs

- [x] 8.1 Apply the `package-store-management` delta: the removed opt-in, the provisioner constant, the container rule, `store use`, the richer inspection, and the download remedy
- [x] 8.2 Apply the `lib-store-provisioning` delta: the removed variant requirement, the new architecture requirement, the unconditional store pass, and the inventory failure mode
- [x] 8.3 Apply the `lib-store-download` delta: the unconditional download and the gate that makes sure of a store
- [x] 8.4 Apply the `setup-answers` delta: `--sandbox` names no variant, and a pull obtains both images
- [x] 8.5 Correct the `Purpose` section of `openspec/specs/lib-store-provisioning/spec.md`, which is still the archive placeholder

## 9. Verification

- [x] 9.1 Do a test that the CLI passes the store root for every sandbox, with a configuration file that carries no store key
- [x] 9.2 Do a test that the gate has no state which passes without a store
- [x] 9.3 Do a test that an unreadable inventory refuses the action and names the remedy
- [x] 9.4 Do a test of `store use` against a stub filesystem. The pointer must resolve at every step of the rename
- [x] 9.5 Do a test of each refusal of `store use`, and make sure that the pointer stays unchanged
- [x] 9.6 Do a test that `--force` switches under a held lock, and that it names the risk first
- [x] 9.7 Do a test that `--force` still refuses an incomplete farm, an absent farm, an in-flight download, and a dot-prefixed name
- [x] 9.8 Do a test that `store ls` reports a pointer that resolves to nothing, and the track set of each farm
- [x] 9.9 Do a test that `store add` pulls the provisioner image when it is absent
- [x] 9.10 Do a test that `inflexa sandbox pull python-r` reports the retired argument and pulls nothing
- [x] 9.11 Do a test that a download which adds a farm and keeps `current` names the switch command
- [x] 9.12 PART SUPERSEDED by `detached-store-download-lifecycle` — Do a test of the first run on a machine with no store. The app must open, and the first sandbox action must hold with the download state and its byte total. The app-open consent goes, because setup owns the consent
- [x] 9.13 Do a test that a failed download leaves chat usable, offers a retry at the next sandbox action, and starts no sandbox
- [x] 9.14 Update the agent policy snapshot in `agent_policy_tree.test.ts` for the new `store use` grant

## 10. Open decisions

- [x] 10.1 RESOLVED — `--sandbox` is a bare flag, and the flag and the file share one grammar. The presence is the consent, and the absence skips the images and the catalog. The file writes `sandbox: true`, and there is no boolean value and no string value. A retired variant name is still refused. The schema refuses `sandbox: python-r` in the file, and the registry refuses the `--sandbox python-r` positional. Each refusal names both spellings
- [x] 10.2 RESOLVED — an update keeps the old store version. The pool is content-addressed, thus an update adds only the directories whose content changed, and it removes nothing. `inflexa store reclaim` is the one removal path, and it obeys the live requirement "Reclamation is never implicit". `store ls` reports the reclaimable bytes, thus a user sees the disk that an update leaves behind
