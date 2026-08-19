# Grill round 8 — the cache design, the transfers, and the answers file

## W1 — the per-analysis cache design, end to end

The problem it solves: numba and matplotlib write compiled caches at run
time. Without a warm cache, `import scanpy` work can cost 20-30 minutes.
The catalog build warms the default packages (decision 6). The open part
was where a USER analysis keeps its own warm entries.

The design, stage by stage:

1. **Build time.** The preparation run executes the per-package warm
   scripts and records the cache entries in the catalog `inflexa.lock`.
   The bundle ships the prepared caches inside the catalog farm.
2. **Farm creation.** When the CLI makes a farm, it copies the prepared
   catalog caches into a per-analysis cache directory
   (`farm-caches/<analysisId>`). Thus a new analysis starts warm for the
   default packages.
3. **Mount.** The farm resolution carries the cache location. The harness
   mounts it read-write at `/mnt/libs/cache`, after the two read-only
   store binds. `NUMBA_CACHE_DIR` and `MPLCONFIGDIR` point into it.
4. **Run time.** A kernel that an analysis compiles lands in its own
   cache, and a second run loads it with no second compile. A
   user-acquired package warms this way, at first use.
5. **Fallback.** A resolution with no cache location mounts nothing. The
   entrypoint then copies the template caches to `/tmp`, and warm entries
   die with the container.

Why per analysis and not shared: a loaded numba entry (`.nbc`) is machine
code. A shared writable home would let one analysis plant code that a
different analysis executes (`27bc068b`).

The cost: one cache copy per analysis on disk. The copies are tens to
hundreds of MB, and `remove-farm` deletes the cache with the farm.

## W2 — the image transfers, aligned with the vision

Your vision, paraphrased: item 2 says that the image downloads run as
detached processes, like the OCI download, so the setup never blocks. Item
6 says that a TUI command re-downloads the packages and the images. My
delta kept a foreground `sandbox pull`, and that contradicts item 2. The adjustment:

- `inflexa sandbox pull` starts the two image transfers DETACHED and
  returns at once, with a pointer at `inflexa sandbox status`. No
  foreground pull exists anywhere.
- The TUI re-download command starts the same detached transfers, and the
  rows show the progress.
- The dev-channel pre-flight (`inflexa run`, `inflexa profile`) refuses
  with the command hint when an image is absent. It starts no foreground
  pull, because the transfer lifecycle is the one mechanism.

The vocabulary: "variant" dies. The two images are two ROLES of one
feature set: the **runtime image** (`sandbox-base`) runs the analyses, and
the **provisioner image** (`sandbox-provisioner`) installs the packages.
The spec text names them by role, and no spec says "variant".

## S2 — the answers file, the context

Batch setup takes its answers from flags or from a strict YAML file
(`setup --yes --config fleet.yml`). Each answer has a file key. The old
form was `sandbox: python-r`, a variant string. With the variant gone, the
answer is a pure consent, thus the natural file form is a boolean:

```yaml
sandbox: true
```

`sandbox: false` and an absent key mean the same thing: no transfers, and
the pull-later hint prints.
