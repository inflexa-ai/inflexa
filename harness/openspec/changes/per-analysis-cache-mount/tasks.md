# Tasks — Per-Analysis Cache Mount

## 1. The resolution and the mount

- [ ] 1.1 Add the cache location to the farm resolution in `sandbox/types.ts`, beside the farm location
- [ ] 1.2 Mount the cache read-write at `/mnt/libs/cache` in the Docker backend, nested inside the store mount
- [ ] 1.3 Mount the cache in the Kubernetes backend, as a second mount of the store PVC with a subPath
- [ ] 1.4 Let a resolution name a farm and no cache, and start the sandbox with no cache mount
- [ ] 1.5 Do a test: the cache mounts read-write, the store and the farm stay read-only
- [ ] 1.6 Do a test: a resolution with no cache starts the sandbox, and it refuses nothing

## 2. The seed file of the image

- [ ] 2.1 Make `seed_caches` export the cache env at the mounted cache, and copy no file
- [ ] 2.2 Export nothing when no cache is mounted, thus a run with no cache compiles into the container
- [ ] 2.3 Keep the aarch64 CPU name export, because a numba key holds the CPU that prepared the entry

## 3. The farm links

- [ ] 3.1 Remove the cache links from the mount contract of a farm: a farm carries packages and markers only
- [ ] 3.2 Do a test: a sandbox against a farm with no cache links reads its caches through the mount

## 4. The effectiveness check

- [ ] 4.1 Point the check at a seeded cache mounted read-write, beside a read-only composed farm
- [ ] 4.2 Seed the check cache with the seed rule: hardlink the numba entries, copy the matplotlib directory
- [ ] 4.3 Do a test: each recorded entry loads through the mount, and the catalog directories stay unchanged
- [ ] 4.4 Do a test: a run-time compile lands in the mounted cache, and the check still passes

## 5. The spec sync

- [ ] 5.1 Make sure that the deltas of `agent-requested-packages` and `per-analysis-farm-mount` hold beside these deltas
- [ ] 5.2 Run `openspec validate per-analysis-cache-mount --strict` and resolve each finding
