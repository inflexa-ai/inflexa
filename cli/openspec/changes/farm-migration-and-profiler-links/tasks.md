# Tasks: farm-migration-and-profiler-links (cli side)

## 1. The full composition

- [x] 1.1 Write a red test first: a farm-less analysis composes the catalog closure, and a present farm stays untouched.
- [x] 1.2 Add the full-farm composition to `src/modules/libs/composition.ts`, from `readFarmClosure` of the catalog, through the staging swap.
- [x] 1.3 The healed farm copies the catalog `inflexa.lock` verbatim.
- [x] 1.4 The two heals of one analysis serialize under the store lock.

## 2. The eager empty farm

- [x] 2.1 Write a red test first: analysis creation makes the farm with an empty lock before the profile trigger.
- [x] 2.2 Make the empty farm in the creation flow. The lock holds the schema, the arch, and an empty package list.
- [x] 2.3 A farm-make failure stops the creation, and the message names the farm path, the cause, and the retry.

## 3. The heal triggers

- [x] 3.1 The analysis open heals full when the catalog is present.
- [x] 3.2 The transfer poll of the open session runs the heal when the catalog row lands.
- [x] 3.3 With no catalog and no live transfer, the open prompts for the download, with one consent.
- [x] 3.4 A launch between the consent and the landing refuses with the classified live-transfer reason.
- [x] 3.5 Change `resolveAnalysisFarm` from heal-empty to heal-full as the backstop (`src/modules/harness/runtime.ts:952`), and update its comment.

## 4. The T2 wiring

- [x] 4.1 Pass `extendAnalysisFarm` into the profile deps at the composition root, the same realization as the step agents.
- [x] 4.2 Depends on the harness change of the same name. The signal is harness task 1.1, landed in the linked working copy.

## 5. The proof

- [x] 5.1 Run `bun run typecheck`, `bun run lint`, and `bun run test`.
- [x] 5.2 Retest in the TUI: open a pre-release analysis, and make sure that the farm heals full and the launch gate passes.
