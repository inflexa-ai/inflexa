# Proposal: package-store-rebuild (cli)

## Why

The harness change `package-store-rebuild` (in `harness/openspec/changes/`)
gives the seams: the per-analysis farm source, the farm-extension seam, the
`inflexa.lock` gate, and the declared toolchain. The CLI is the embedder, and
this change binds those seams and builds the user experience around them. The
decision record is `docs/feat_localPackages/decisions.md` at the repository
root, with the grill rounds 3 to 6.

## What Changes

- The CLI owns a host package store at a constant root: the pool, one farm
  per analysis, and the graph. The store is mandatory, because no image bakes
  a library.
- The composition root binds `farmSource: per-analysis`, the farm-extension
  seam, and `toolchainSource: "image"`.
- A farm is made empty with its analysis, it extends additively, and it dies
  with its analysis. The delete flow gate hardens against stale `running`
  rows, and no lease exists.
- The `inflexa store` command family: `add` (one package per call, with
  `--version` and `--lang`), `link`, `ls`, `download`, `cancel`, `reclaim`.
  No `store use` and no `store verify` exist.
- The acquisition flights gain the pending set: per-package asks in the
  chat, and one one-shot provisioner run per batch. The flight ends with the
  load check inside the sandbox image, before the graph commit.
- An unqualified package name that both ecosystems satisfy stops with an ask
  to the user, at acquisition and at link time. No silent Python win.
- The setup starts three detached transfers at the start of setup, after one
  consent: the runtime image, the provisioner image, and the catalog. Three
  progress rows show in the setup screen and the TUI, and they disappear
  when complete.
- A superseded image is removed only after the new pull verifies, and the
  TUI says so. The catalog merge stays add-only, and `--update` replaces the
  graph.
- The conversation flow: after the plan, the agent writes the package list,
  marks the missing packages, and asks per package through the run-inflexa
  approval. A refusal guides the agent to a replacement, and the prompt
  carries the swap invitation.

## Capabilities

### New Capabilities

- `package-store-management`: the `inflexa store` command family and the
  agent policies of each command. It also covers the flight machinery with
  the pending set, the two-phase acquisition, and the ecosystem asks.
- `package-store-download`: the catalog as a digest-pinned OCI artifact —
  the resolve, the receipt, the add-only merge, and the `--update` consent
  that replaces the graph.
- `package-store-transfers`: the detached transfer lifecycle that the three
  transfer kinds share. It covers one child per transfer, the database rows,
  the lock-based liveness, the blob-cache resume, and the TUI progress
  surface.
- `farm-composition`: the per-analysis farm lifecycle. A farm is made empty
  with its analysis, extends through the graph closure, and dies with its
  analysis. The capability also covers the link-time both-hit ask and the
  per-farm mutex.

### Modified Capabilities

- `lib-store-provisioning`: one runtime image and one provisioner image, no
  variant choice, no baked store, and `sandbox remove` removes both images.
- `setup-answers`: the `--sandbox` answer is one consent for three
  transfers, and the transfers start at the start of setup. A second setup
  never blocks on a live transfer.
- `chat-wiring`: the image gate leaves the launch preamble. The app renders
  at once, and the wait surfaces at the first sandbox-making action.
- `harness-runtime`: the composition root binds `farmSource`,
  `extendAnalysisFarm`, and `toolchainSource`, and the refusal text of a
  pool miss names `inflexa store add` as the remedy.

## Impact

- `cli/src/modules/libs/` (the store, the flights, the composition, the
  download), `cli/src/modules/infra/setup.ts`, `cli/src/modules/harness/`
  (runtime bindings, the run-inflexa policies), `cli/src/tui/` (the gate,
  the sidebar, the commands), `cli/src/lib/lock.ts`, and the database
  migrations for the transfer rows.
- The store term renames the config keys and the lock keys
  (`libStoreDir` to the package-store form), per decision 14.
- The CLI consumes the harness seams from the linked working-copy harness
  during this work (`bun run harness:local`).
- Out of scope: the managed delivery, and the R acquisition of the `github`
  and `git` tracks (catalog-only by decision 4).
