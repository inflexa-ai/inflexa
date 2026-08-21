# Tasks: package-store-rebuild (cli)

The spike worktree is a read-only reference. Copy a proven fragment after
you read it. Do not cherry-pick a commit.

## 1. The composition root

- [x] 1.1 Pass the store root as `libStorePath`, and bind `farmSource: { kind: "per-analysis" }` with the empty-farm healing resolver
- [x] 1.2 Bind `extendAnalysisFarm` to the composition linker
- [x] 1.3 Declare `toolchainSource: "image"`
- [x] 1.4 Append the CLI remedy text to a link refusal, with the exact `inflexa store add` command
- [x] 1.5 Rename the store config keys and the lock keys to the package-store forms

## 2. The store and the graph

- [x] 2.1 Port the composition module: the pool paths, the overlay linking, the closure walk, the per-farm mutex
- [x] 2.2 Write and read `inflexa.lock` at schema 1, and remove the legacy marker writers
- [x] 2.3 Add the both-hit refusal at link time, and remove the Python-first search order
- [x] 2.4 Port `store reclaim`, with the live-composition enumeration through the lock holds

## 3. Farms

- [x] 3.1 Make the empty farm with the analysis, and heal a missing farm at the first sandbox action
- [x] 3.2 Seed the per-analysis warm cache from the catalog caches at farm creation
- [x] 3.3 Remove the farm on analysis delete, and harden the delete gate against stale `running` rows

## 4. The command family

- [x] 4.1 Register `store add`: one package, `--version`, `--lang`, `--analysis`, policy `approval`
- [x] 4.2 Register `store link` (`auto`, `analysis` safe), `store ls` (`auto`), `store reclaim` (`approval`), and no `use` or `verify`
- [x] 4.3 Rework `sandbox pull` (two images, no variant), `sandbox remove` (`blocked`), and `sandbox status`

## 5. Flights and the pending set

- [x] 5.1 Add the pending set, with the flush at the end of the agent turn and the explicit flush
- [x] 5.2 Run one provisioner run per batch, with one outcome per spec
- [x] 5.3 Add the ecosystem search and the both-hit ask at acquisition
- [x] 5.4 Run the load check inside the sandbox image, then append the staged nodes under the metadata lock
- [x] 5.5 Refuse `store add` during a live merge

## 6. Transfers

- [x] 6.1 Add the transfers table migration: the three kinds, the states, the byte totals, the failure message
- [x] 6.2 Add the detached child per kind, with the hidden flag, ignored stdio, `unref`, and one lock per kind
- [x] 6.3 Image transfer child: pull, make sure of the digest, then remove the superseded image with a notice
- [x] 6.4 Catalog child: the ORAS resolve, the blob cache, the add-only merge, the receipt last, and the `--update` graph replace
- [x] 6.5 Wire `store download` and `store cancel` to the rows

## 7. Setup and the TUI

- [x] 7.1 Move the transfer step to the start of setup, with the one bare `--sandbox` consent and no wait
- [x] 7.2 Make a second setup non-blocking, and write the `declined` state on a decline
- [x] 7.3 Render one progress row per live transfer in the setup screen and the sidebar, and drop each row on completion
- [x] 7.4 Rework the sandbox gate: wait on live transfers, refuse terminal states with the retry command, start nothing
- [x] 7.5 Remove the image gate from the launch preamble, and keep the terminal pre-flight in the dev commands

## 8. The conversation

- [x] 8.1 Add the post-plan package list and the per-package asks to the conversation prompt and wiring
- [x] 8.2 Add the swap invitation and the refusal guidance to the prompt

## 9. Tests and verification

- [x] 9.1 Unit tests: the composition, the lock schema, the both-hit asks, the pending set, the gate
- [x] 9.2 Update the agent-policy tree snapshot for the new command surface
- [x] 9.3 Run `bun run typecheck`, `bun run lint`, and `bun test`
