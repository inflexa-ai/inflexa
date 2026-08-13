## Context

`per-analysis-farm-mount` and `per-analysis-farms` move the package set from the
image into the store. Two things move with it, and one of the two did not arrive.

The prepared caches moved. The image of the earlier design baked them
(`images/sandbox-python/Dockerfile:194-218`), that image goes away, and
`seed_caches` in `images/sandbox-base/sandbox-entrypoint.sh` now reads them from
the farm at `/mnt/libs/current`. `provision.py` holds the producer in `warm()`,
and `composition.ts` links the two cache directories from the template into each
analysis farm. The catalog build calls the producer nowhere, thus the whole chain
ends at an empty source.

The path to the farm moved. `current` was a symlink inside the store root, thus
one bind of that root carried a farm into any container. The harness took the job
up as a second bind. No other invoker did: `warm()` reports a warning and goes
on, and `scripts/lib-store-sandbox-checks.sh` reads `/mnt/libs/current` in four
places and binds nothing there.

Two requirements already state the correct behavior. `lib-store-provisioner`
says that preparation runs through the container path the sandbox imports from,
and that it executes a workload rather than an import. `lib-store-build` says
that the build proves the cache takes effect, and that the presence of cache
files is not evidence. Thus most of this change closes a conformance gap, and it
adds one new rule: a preparation run that cannot obey the path rule fails.

## Goals / Non-Goals

**Goals:**

- The published catalog carries prepared caches again, and the build proves that
  they load at run time.
- An invoker that cannot satisfy the cache-path rule learns so at the run, and
  not from a slow sandbox weeks later.
- The R load check and the image-owned package list describe the sandbox image,
  which is the image that matters.
- The `store-root` farm source carries a name that matches what the code reads.

**Non-Goals:**

- New packages in the catalog. The workload exercises the set that the manifest
  already names.
- The composition-against-reclaim invariant. `composeFarm` is safe today because
  a default farm links exactly what the catalog template links. That invariant
  belongs to `farm-composition` in the `cli` spec tree.
- A change to the cache set. `lib-store-provisioner` already says that a third
  cache arrives only by an amendment of that requirement.

## Decisions

### D1 — The manifest declares the workload, and the build passes it

`images/lib-store-manifest.yaml` gains a `warm` key with two fields: `modules`,
a list of module names, and `script`, a repository path. The manifest already
decides which packages exist, thus the workload that exercises them belongs
beside them. A workload in the workflow arguments drifts from the package list,
because two files then change apart.

The BUILD reads the key, and it passes the existing `--warm` and `--warm-script`
flags. It parses the manifest for `PY_SPECS` already, thus the key needs no new
mechanism. The provisioner keeps the interface that it has.

The provisioner does not read the key. A manifest reaches it only through
`--r-manifest` (`images/sandbox-provisioner/provision.py:1556`), which
`provision_r` alone reads. A second reader of that path would tie the whole
workload to the R flag.

The flags stay, and they stay necessary. `scripts/lib-store-sandbox-checks.sh`
builds a two-package farm and names its own workload, with no manifest at all.
The manifest describes the catalog, and that farm is not the catalog. Thus the
flags are the interface, the manifest is one caller, and no rule of precedence
is necessary.

Alternative — the provisioner reads the key: rejected, it couples the workload
to the R manifest flag and it adds a second source of one value.

### D8 — The workload script exercises the calls that an analysis makes

numba keys a cache entry on the type signature of a call. Thus a script that
calls one function with one signature prepares one entry. Such a script passes
the effectiveness check, and it leaves a real analysis to compile.

The script MUST call, for each module of the `warm` list, the entry points that
a first analysis reaches. It carries a comment for each call that names why that
call is on the path of an analysis. A call that no analysis makes prepares an
entry that no sandbox loads, thus it costs build time and gives nothing.

The check counts loads against writes for the recorded workload only, thus the
check cannot judge the coverage of the script. A person judges it, and the
comments are what makes that judgment possible.

### D2 — A preparation run with no farm bind fails

`warm()` reports a warning today and writes a cache anyway. A cache that a run
writes through another path never loads, thus such a run costs build minutes and
produces nothing. The run fails instead, and it names the bind that it wants.

This is what would have caught the gap. The warning existed for the whole life of
the no-pointer store. No person read it, because no build printed it.

Alternative — keep the warning and add a build-side assertion: rejected. It
leaves the same trap for the next invoker, and the provisioner is the one place
that knows the rule.

### D3 — The build prepares, and then it proves

The catalog build gains a preparation step after the farm build, with the farm
bound at `/mnt/libs/current`. The effectiveness check that `lib-store-build`
already demands then runs against the published store.

The two steps stay separate. Preparation writes the cache, and the check reads it
as the sandbox reads it, under the unprivileged user against a read-only store.
One step that did both would prove nothing, because it would hold the writable
paths that make a cache load.

### D4 — The acceptance checks bind the farm that they read

`scripts/lib-store-sandbox-checks.sh` binds the target farm at
`/mnt/libs/current` for its preparation run and for each sandbox run. The script
reads that path in its cache prologue, in `replay_check.py`, in `validate.py`,
and through the `.pth` and `R_LIBS_SITE` that the image bakes. Thus the bind is
what makes any section of it run at all.

### D5 — The farm source loses the kind that nothing produces

`store-root` gates on `<store root>/current`
(`harness/src/sandbox/docker-client.ts:327`), and the comment at
`harness/src/sandbox/types.ts:254` describes a different shape. That mismatch is
not the reason to act. The reason is that nothing makes the shape, and nothing
asks for it.

`flip_current` was the one producer of an in-store `current`, and
`per-analysis-farm-mount` deletes it. One production site constructs a
`FarmSource`, which is `cli/src/modules/harness/runtime.ts:871`, and it names
`per-analysis`. A deployment that serves one library set names `fixed`, which
mounts that farm and needs no symlink.

Thus the kind goes, `farmSource` becomes necessary, and the `<root>/current`
fallback goes with it. An embedder that names no source then fails to compile.
That beats a store which mounts nothing at run time and says so in a log line.

The published package gains a breaking change, and that is deliberate. The CLI
is the one known consumer, and it already names `per-analysis`.

Alternative — rename the kind: rejected. A better name for a path that no code
reaches is still a path that no code reaches.
Alternative — gate on the store root itself: rejected, no store has that shape.

### D6 — The image-owned package list is compared against the image

`base-packages.json` is a hand-kept claim about the sandbox image, and nothing
holds it to that image. The two failures are not symmetric. A name that the file
omits stops the build at the edge gate, which is loud and safe. A name that the
file lists and the image does not own drops a real edge. The closure then runs
short, and an import fails inside the sandbox, where nothing explains it.

A test reads the installed set of the sandbox image and compares it to the file.
The dangerous direction is the one it must cover: each name in the file exists in
the image.

### D7 — The R load check resolves through the farm alone

`check_r_loads` appends `.libPaths()` to the three farm paths
(`images/sandbox-provisioner/provision.py:808`). Thus a package resolves through
the library of the provisioner image, and the check proves that it loads there.

The two images pin one base — `rocker/r-ver:4.6.0@sha256:6f05a1a8...` at
`images/sandbox-base/Dockerfile:23` and `images/sandbox-provisioner/Dockerfile:17`
— and `sandbox-base` installs no R package. The provisioner installs `pak` and
`yaml`. That two-package delta is the whole masking surface.

It already caused one defect in this work. `devtools` imports `pak`, the load
check passed because the provisioner has `pak`, and only a live sandbox showed
the gap. The remedy at the time named `pak` in the manifest. The check must stop
producing that class of defect.

The check moves into a `sandbox-base` container. It resolves each farmed package
through the three `R_LIBS_SITE` paths of a real sandbox, thus it proves what the
spec of this capability already asks: that a sandbox calls `library()` and
succeeds. A tail of `.libPaths()` inside the provisioner cannot prove that,
whatever it holds.

The move costs one ordering property, and this is the trade. The provisioner
cannot start a container, thus the check leaves `provision_r`
(`images/sandbox-provisioner/provision.py:927`) and becomes a step of the
invoker. Today it runs before `publish_farm` (line 1498) and gates the farm.
After the move it runs after the farm publishes, and it gates the catalog
artifact instead.

That trade is permitted, because the two publishes are not equal. A farm and its
store directories are content-addressed and reachable by no user until an
artifact ships them. The artifact is the publish that reaches a user, thus the
gate belongs there.

The provisioner records the farmed R packages, which it already holds as
`stored`. The check reads that record, thus it needs no walk of the farm and it
tests exactly the set that the run produced.

A package whose runtime dependency the sandbox image owns then wants that name in
`base-packages.json`, which is the record that D6 makes trustworthy.

## Risks / Trade-offs

- [The build time drifts] Preparation runs a fixed workload and it terminates,
  thus the step cannot run away. The risk is drift: the workload grows as
  packages arrive, and no person sees the build slow down. The workflow sets no
  `timeout-minutes`, thus the only backstop is the 6-hour default of GitHub. →
  Record the measured time of the step when it lands, and set
  `timeout-minutes` from that measurement.
- [A farm publishes before the R check runs] D7 moves the load check after
  `publish_farm`. Thus a farm that holds a package which does not load can reach
  the store of the build. → The catalog artifact is the publish that reaches a
  user, and the check gates that artifact. A store directory that no artifact
  ships reaches nobody.
- [A hard failure where a warning stood] An invoker that prepares caches with no
  bind now fails its run. → Two invokers exist, and this change fixes both. A
  third invoker gets a message that names the bind.
- [The R load check gets stricter] A package whose runtime dependency the
  provisioner owns and the sandbox does not now fails the check. → That is the
  point, and it is the `pak` defect found early instead of late. The remedy is
  the manifest or `base-packages.json`, and the failure names the package.
- [The comparison of D6 needs the sandbox image] A test that reads the installed
  set wants that image present. → It runs where the build already has the image,
  beside the checks that use it.
- [Preparation and the effectiveness check disagree] A workload recorded in one
  place and replayed in another can drift. → `lib-store-provisioner` already
  makes the run record its workload and the check replay that recording. The
  manifest key becomes the one source that both read.

## Migration Plan

1. Add the `warm` key to the manifest, and write the workload script. The
   provisioner keeps its flags, thus this step changes no interface.
2. Make a preparation run with no farm bind fail, and supply the bind in the
   two invokers that prepare caches.
3. Read the key in the catalog build, pass the flags, and run the effectiveness
   check against the published store.
4. Rename the farm-source kind, and adjust the delta of
   `per-analysis-farm-mount` where it names the old kind.
5. Move the R load check into a `sandbox-base` container, and add the comparison
   of the image-owned list.

Steps 4 and 5 rest on nothing in steps 1 to 3, thus the two halves land in
either order.

## Open Questions

(none — the decisions above were settled in conversation with the user)
