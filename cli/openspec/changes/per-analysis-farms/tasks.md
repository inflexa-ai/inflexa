# Tasks — Per-Analysis Farms

## 1. The graph reader and the composer

- [x] 1.1 Add the `deps.json` reader: parse the nodes, index by store-directory name, and refuse a graph with a dangling edge
- [x] 1.2 Write the closure walk: roots in, the reachable node set out, with a named error for an unknown root
- [x] 1.3 Write the link pass: top-level entry links with namespace-directory promotion, R inner-directory links, and the relative bin hoist
- [x] 1.4 Write the marker pass: `packages.txt`, `meta.json`, and `lock.json` in the shared inventory shape
- [x] 1.5 Link the warm-cache directories of the catalog template into the composed farm
- [x] 1.6 Add the per-farm mutex, an instance-lock file beside the farm
- [x] 1.7 Add the version-collision refusal: a shared top-level name from two store directories fails with both names
- [x] 1.8 Build the golden-fixture parity test: one fixture pool, the TS composer against the provisioner builder, tree for tree
- [x] 1.9 Wire the parity test into CI so it runs the Python side

## 2. The lifecycle

- [ ] 2.1 Make the farm at `analysis new`, empty and with its markers, and make the provider return it rather than compose one
- [x] 2.2 Build the extension path: additive links only, safe under a live sandbox, behind the per-farm mutex
- [x] 2.3 Remove the farm in `analysis delete`, after the lease check
- [x] 2.4 Add the orphan-farm reaper to the reclaim command, keyed on the analyses table
- [ ] 2.5 Do a test: a chat-only analysis keeps an empty farm, which passes the usability gate and links no package
- [x] 2.6 Do a test: an extension reaches a live sandbox without a restart

## 3. The provider wiring

- [x] 3.1 Supply the farm provider at the composition root in `runtime.ts`: analysis id to `farms/<analysisId>` under `env.libStoreDir`
- [ ] 3.2 Make the provider return the farm that `analysis new` made, and return no farm when it is absent or incomplete
- [x] 3.3 Surface the composition-failure state in the sandbox gate, with the reason
- [x] 3.4 Point the planning inventory at the pool inventory of the store
- [x] 3.5 Do a test: two analyses, two farms, one sandbox each, each mounts its own

## 4. The store command surface

- [x] 4.1 Remove `inflexa store use` and its registry entry
- [x] 4.2 Re-scope `inflexa store add` to acquisition: no farm work in the provisioner invocation
- [x] 4.3 Add the flight table and its states, in the shape of the download lifecycle row
- [x] 4.4 Build the flight key: ecosystem, canonical name, specifier
- [x] 4.5 Build subscribe on a live flight, cancel as unsubscribe, and stop at zero subscribers
- [x] 4.6 Cap concurrent flights at the configured limit, default 2, and queue the rest
- [ ] 4.7 Make each caller extend its own farm when the flight succeeds, and stop the owner from extending the farm of another caller
- [x] 4.8 Report live flights in `inflexa store ls` and the sidebar
- [x] 4.9 Make reclaim exclusive against live flights
- [x] 4.10 Do a test: two identical adds share one flight, and both farms extend on success
- [x] 4.11 Do a test: two different adds run in parallel under the cap

## 5. The download merge

- [x] 5.1 Drop the `current` write from the merge order in `store_download.ts`
- [x] 5.2 Merge `deps.json` as a top-level store record, and replace it on `--update` under the metadata mutex
- [x] 5.3 Update the merge report: store directories added, farms added, farms kept
- [x] 5.4 Do a test: a fresh merge leaves no `current`, and the template farm is present

## 6. The migration and the inspection

- [x] 6.1 Remove a stale `current` symlink on the first store command, idempotently
- [x] 6.2 Update `inflexa store ls`: name the analysis of each farm, mark the template, and drop the pointer report
- [x] 6.3 Do a test: an upgraded store loses the pointer once, and the farms stay valid

## 7. The spec sync

- [x] 7.1 Adjust the open change `mandatory-store-and-farm-switch` where it names `store use` and the pointer
- [x] 7.2 Make sure that the `detached-store-download-lifecycle` deltas hold with no pointer, and adjust where one is named
- [x] 7.3 Run `openspec validate per-analysis-farms` and resolve each finding

## 8. The farm at analysis creation, and the packages of a plan

- [ ] 8.1 Make `farms/<analysisId>` at `analysis new`, empty and with its markers
- [ ] 8.2 Record the roots of a farm in its lock, thus a later link pass knows what the farm holds
- [ ] 8.3 Read the package set of a plan: link what the pool holds, and ask the user to install what it lacks
- [ ] 8.4 Do a test: a new analysis has an empty farm, and that farm passes the usability gate
- [ ] 8.5 Do a test: a plan that names a package the pool lacks asks the user, and the run waits on the answer
- [ ] 8.6 Do a test: a farm links what a caller named and nothing else, thus no set is pre-linked

## 9. `inflexa store link`, and the two speeds of `store add`

- [ ] 9.1 Add `inflexa store link <packages...>` with a required `--analysis` flag, the `auto` policy, and its row in the policy-tree snapshot
- [ ] 9.2 Take an optional version in the requirement form, and take the head of the ordering when a request names none
- [ ] 9.3 Refuse a package that the pool does not hold, and give an R package a reason of its own
- [ ] 9.4 Add an optional `--analysis` flag to `inflexa store add`, and thread it into the flight
- [ ] 9.5 Join the flight key with `::`, and remove each control character from the source file
- [ ] 9.8 Move the graph reader to schema version 2, because the emitter now records a version ordering
- [ ] 9.9 Give the provisioner runner a second bind of a farm at `/mnt/libs/current`, read-write, so an acquisition can warm
- [ ] 9.6 Do a test: `link` starts no container, it opens no network connection, and it asks for no consent
- [ ] 9.7 Do a test: an add with an analysis extends that farm, and an add with none extends no farm

## 10. The reclamation wait

- [ ] 10.1 Make a composition yield while a live process holds the reclamation lock
- [ ] 10.2 Record the liveness of a composition where a reclamation reads it
- [ ] 10.3 Make a reclamation wait for each live composition before it deletes
- [ ] 10.4 Sweep a liveness record whose process is gone, thus it blocks nothing
- [ ] 10.5 Do a test: a reclamation and a composition never interleave

## 11. The farm-extension seam of the harness

- [ ] 11.1 Bind the seam at the composition root, realized by the composer in the process of the CLI
- [ ] 11.2 Resolve an import name through the graph, thus a step can name `sklearn`
- [ ] 11.3 Do a test: the seam starts no `inflexa` child, and it acquires nothing
- [ ] 11.4 Run `openspec validate per-analysis-farms --strict` again and resolve each finding
