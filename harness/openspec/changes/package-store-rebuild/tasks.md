# Tasks: package-store-rebuild

The spike worktree is a read-only reference. Copy a proven fragment after
you read it. Do not cherry-pick a commit.

## 1. Seams and types

- [x] 1.1 Add `FarmLocation`, `FarmResolution`, `ResolveAnalysisFarm`, and `FarmSource` to `src/sandbox/types.ts`
- [x] 1.2 Add `ExtendAnalysisFarm`, `PackageRequest`, and the four request outcomes to `src/sandbox/types.ts`
- [x] 1.3 Make `farmSource` a necessary field of the client config and both backend configs
- [x] 1.4 Add the `toolchainSource` field with the values `"image"` and `"store"`, absent as `"store"`
- [x] 1.5 Add the `farm_unavailable` variant to `SandboxError`
- [x] 1.6 Export the new seam types from `src/index.ts`

## 2. The mount contract

- [x] 2.1 Make the Docker backend resolve the farm source before container work, and refuse on `unavailable`
- [x] 2.2 Replace the `current`-pointer gate with the `inflexa.lock` gate on the resolved farm
- [x] 2.3 Mount the store and the farm as two nested read-only binds, farm after store
- [x] 2.4 Mount the farm as a PVC `subPath` on the K8s backend, after the store mount
- [x] 2.5 Keep the main-drift behavior of the K8s client: `writableTail`, `podLabels`, the owner annotation, `isAliveById`
- [x] 2.6 Key the mount-plan env on `toolchainSource`, with the farm `python/bin` at the end of `PATH`
- [x] 2.7 Add the optional cache location to the farm resolution, mount it read-write at `/mnt/libs/cache`, and point the cache env at it

## 3. Tools and prompts

- [x] 3.1 Add the `link_packages` tool, in the always-on substrate, only when the seam is bound
- [x] 3.2 Thread the optional seam through the sandbox agent deps and the conversation agent deps
- [x] 3.3 Add the package-link prompt layer, gated on the bound seam
- [x] 3.4 Key the orient-core environment text on `toolchainSource`, and keep the legacy text byte-identical when absent
- [x] 3.5 Make `list_available_packages` read `inflexa.lock` and merge `/opt/inflexa/image-packages.txt`
- [x] 3.6 Withhold the `packages` field in the briefing

## 4. The planner and the launch

- [x] 4.1 Make the `packages` array a necessary field of `PlanStepSchema`, optional in the persistence schema
- [x] 4.2 Add the location refusal to `validate_plan` and the re-validation of `submit_plan`
- [x] 4.3 Add the packages section and the anti-pattern line to the planner prompt
- [x] 4.4 Link the plan packages before the launch, and refuse a pool miss with the missing names

## 5. The provisioner program

- [x] 5.1 Make the entrypoint a subcommand parser: `build`, `acquire`, `prepare`, `reclaim`, `remove-farm`
- [x] 5.2 Run the staging repair as an internal step at the start of each run
- [x] 5.3 Write the pool: content-addressed write-once directories, nested R layout, no `current`, no leases
- [x] 5.4 Write one `inflexa.lock` per farm, and write no `packages.txt`, `meta.json`, or `lock.json`
- [x] 5.5 Port `emit-deps.py`: `packaging` markers, `Depends`/`Imports` edges, the dangling-edge gate, `by_name`
- [x] 5.6 Make `acquire` take a spec set, install under enforced hashes, and stage without advertised state
- [x] 5.7 Add the load check of the acquired set inside the sandbox image, before the graph commit
- [x] 5.8 Report one outcome per spec, and drop a failing spec without the batch
- [x] 5.9 Add the incremental R acquire through pak, CRAN and Bioconductor only, with pool-hit reuse
- [x] 5.10 Add the both-hit refusal for an unqualified name that both ecosystems satisfy
- [x] 5.11 Keep the lock family: shared acquire, short commit mutex, exclusive reclaim
- [x] 5.12 Author the JSON schema of `inflexa.lock`, and validate it in the mount gate and the inventory reader

## 6. The images

- [x] 6.1 Build the conda prefix at `/opt/conda` and Node at `/opt/node` in `sandbox-base` builder stages
- [x] 6.2 Bake the `/opt/inflexa` inventory, with `image-packages.txt`
- [x] 6.3 Add the cache seed file, and source it in the entrypoint before the firewall path
- [x] 6.4 Write the `sandbox-provisioner` Dockerfile, with the base-digest assert against the manifest
- [x] 6.5 Move the manifest to `images/package-store/manifest.yaml`, and add its JSON schema and modeline
- [x] 6.6 Add the per-package warm scripts under `images/package-store/warm/`, one script per warmed package
- [x] 6.7 Add the egress allowlist to the provisioner, with only the pinned index hosts
- [x] 6.8 Cover both Dockerfiles in `droast.toml`

## 7. The workflows

- [x] 7.1 Write `sandbox-images-build.yml`: the two images, multi-arch, in lockstep
- [x] 7.2 Write `package-store-build.yml`: resolve, lock commit-back with sign-off, store emit, load check, coverage report
- [x] 7.3 Add the preparation run and the cache check gate to `package-store-build.yml`
- [x] 7.4 Pack and push the OCI artifact with ORAS, immutable version tags, `latest-<arch>` on push only
- [x] 7.5 Write `package-store-acceptance.yml`: ORAS pull, mount into published `sandbox-base`, import-all, smoke suite
- [x] 7.6 Delete the retired workflows and scripts per the rename table, and add no trigger sentinel

## 8. Tests and verification

- [x] 8.1 Unit tests: the farm-source resolution, the `inflexa.lock` gate, and the env keying
- [x] 8.2 Unit tests: `link_packages` outcomes, the prompt-layer gating, and the byte-identity of the legacy prompt
- [x] 8.3 Unit tests: the plan schema, the location refusal, and the pre-launch link pass
- [x] 8.4 Container rig checks for the provisioner: batch acquire, two-phase commit, both-hit refusal, reclaim
- [x] 8.5 Run `tsc -p tsconfig.json` and `bun test` in `harness/`

## 9. Sync

- [ ] 9.1 Rename the spec folders (`lib-store` to `package-store`, `lib-store-build` to `package-store-build`) at sync
- [x] 9.2 Update the harness `CONTEXT.md` glossary with the package-store terms
- [ ] 9.3 Record the two open decisions in the synced specs: the managed delivery, and the K8s node pin
