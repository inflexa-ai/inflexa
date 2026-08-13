# Tasks — Restore the Warm Cache and Name the Farm Source

## 1. The declared workload

- [x] 1.1 Add a `warm` key to `images/lib-store-manifest.yaml`, with a `modules` list and a `script` path
- [x] 1.2 Name the module set of the earlier image: `numba`, `matplotlib`, `scanpy`, `seaborn`, `pertpy`, `scvi`, `cell2location`
- [x] 1.3 Write the workload script: for each module, call the entry points that a first analysis reaches
- [x] 1.4 Comment each call with the reason that it sits on the path of an analysis
- [x] 1.5 Fail a preparation run when a declared module does not import, or the script exits non-zero
- [x] 1.6 Do a test: a run whose declared module does not import fails and names that module

## 2. The farm bind

- [x] 2.1 Fail a preparation run that cannot resolve the farm at the container path, and name the mount
- [x] 2.2 Bind the target farm for the preparation run of `scripts/lib-store-sandbox-checks.sh`
- [x] 2.3 Bind the target farm for each sandbox run of that script
- [x] 2.4 Do a test: a run with no farm mount fails, and it writes no cache
- [x] 2.5 Run the sandbox checks end to end, and make sure that each section passes

## 3. The catalog build

- [x] 3.1 Read the `warm` key in the build, beside the step that parses `PY_SPECS` from the manifest
- [x] 3.2 Add the preparation step as a SECOND run, with no spec and with the farm bound. A run that builds a farm cannot warm it, because the publish replaces the directory that the bind holds
- [x] 3.3 Record the prepared cache entries in the run, beside the workload that it recorded
- [x] 3.4 Extract the replay check, so the build and the acceptance script share one implementation
- [x] 3.5 Judge the check on the recorded set: each entry loads, and a write outside the set passes
- [x] 3.6 Run that check in the build against the published store, as the unprivileged runtime user
- [x] 3.7 Fail the build when the check counts a cache write for a recorded entry
- [x] 3.8 Set a provisional `timeout-minutes` on the job, with a comment that names it provisional
- [ ] 3.10 Revise `timeout-minutes` from the first real run. No run of the job with these steps exists, thus nothing measured it
- [x] 3.9 Do a test: a build that runs no preparation step fails the check. A workflow cannot omit its own step, thus the exit-2 path of the check covers it: a farm with no record refuses and publishes nothing

## 4. The farm source

- [x] 4.1 Remove the `store-root` kind from the `FarmSource` union in `harness/src/sandbox/types.ts`
- [x] 4.2 Make `farmSource` necessary on `CreateSandboxConfig` and on each backend config
- [x] 4.3 Remove the `<store root>/current` fallback at `harness/src/sandbox/docker-client.ts:327`
- [x] 4.4 Remove the `store-root` branch of `farmProviderOf` in `mount-plan.ts`, and update `k8s-client.ts`
- [x] 4.5 Adjust the delta of `per-analysis-farm-mount` where it names the removed kind. No edit was necessary: the delta names the store-root MOUNT and never the kind
- [x] 4.6 Update each test that constructs the kind or omits `farmSource`
- [x] 4.7 Run `tsc -p tsconfig.json` in `harness` and in `cli`, thus the break shows at each consumer

## 5. The R load check

- [x] 5.1 Record the farmed R packages in the run, thus the check reads a record and walks no farm
- [x] 5.2 Remove `check_r_loads` from `provision_r`, because the provisioner cannot start a container
- [x] 5.3 Run the check in a `sandbox-base` container, through the `R_LIBS_SITE` paths of the farm
- [x] 5.4 Gate the catalog artifact on that check, because the farm publishes before the check runs
- [x] 5.5 Add the check to `scripts/lib-store-sandbox-checks.sh`, thus a local run proves the same thing
- [x] 5.6 Do a test: a package whose runtime dependency only the provisioner image owns fails the check

## 6. The image-owned package list

- [x] 6.1 Add the test that compares `base-packages.json` against the installed set of the sandbox image
- [x] 6.2 Fail that test when the list names a package that the image does not own
- [x] 6.3 Add a revealed name to the manifest when the sandbox needs the package, and to the list when the image carries it
- [x] 6.4 Remove `uv` from the list. The image carries the command and not the distribution, thus the name belongs to neither file

## 7. The spec sync

- [x] 7.1 Run `openspec validate restore-warm-cache-and-name-farm-source --strict` and resolve each finding
