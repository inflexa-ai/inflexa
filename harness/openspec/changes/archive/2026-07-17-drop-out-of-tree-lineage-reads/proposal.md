## Why

A customer's enrichment step died with `lineage_attestation`, taking the run
with it. The `Logger` seam shipped in 0.3.0 named the cause on the first
occurrence:

```
[reconcile-manifest] input read resolves outside the analysis tree
  path:      /019f6a20-1a3b-7000-a942-ae871e5de040/..
  hostPath:  /Users/radu/.../.inflexa/analyses
  throwSite: workspace-root-bound
```

A capture layer reported a read of `/{resourceId}/..`. The analysis tree mounts
at `/{resourceId}`, so inside the container that path is `/` — the container
root. Opening it is benign and says nothing about the analysis. But
`fillInputHashesFromDisk` maps container paths onto the host by string
arithmetic, and `path.join(resourceRoot, "..")` lands above the workspace root.
The bound check catches that correctly — and then throws, killing the step.

The throw is the defect. An out-of-tree read is **not drift**: nothing about the
analysis has changed, and no lineage edge is at risk. It is a read of something
the analysis does not track — the same category as a directory read
(`ls` of a mount), which this same function already drops rather than failing.
The spec's own invariant is "never register a hashless lineage edge"; dropping
the ref satisfies it exactly as well as throwing does, without destroying a
legitimate analysis.

The asymmetry is visible in one file. `reconcileManifestWithDisk` skips an
out-of-bounds *output* with a warn (`reconcile-manifest.ts:77`), citing
`../../etc/passwd`. `fillInputHashesFromDisk` throws on an out-of-bounds *input*
(`:165`), citing the same example. Same guard, same threat, opposite responses.

Reads outside the analysis tree are supposed to be filtered at the sandbox —
the capture hooks match on `PROVENANCE_DATA_PREFIXES`, so `/usr/lib/...` and
`/mnt/refs/...` never reach the host, and the lineage graph already describes
only in-tree inputs. Dropping a leaked out-of-tree read therefore *restores* the
intended graph rather than degrading it. The sandbox-side leak is fixed
separately (`recordOp` now canonicalizes before matching watch dirs); this change
makes the harness resilient to it regardless of which sandbox image a host runs,
which matters because the image is `workflow_dispatch`-only and `:latest`-tagged
— a host on an older image would otherwise keep failing.

## What Changes

- `fillInputHashesFromDisk` SHALL **drop** a tracked input whose path resolves
  outside the analysis tree — at either bound (container-prefix or
  workspace-root) — via `collector.dropInput(ref)`, and continue. It no longer
  throws for this condition.
- The drop is logged at **warn**, not debug: unlike a directory read (an
  ordinary `ls`, logged at debug), an out-of-tree read means a capture layer
  reported something it should have filtered. It is not worth a dead analysis,
  but it is worth noticing. The record carries the ref, the resolved `hostPath`,
  and a `boundSite` discriminator.
- Fail-fast is **unchanged for genuine drift**: an in-tree input that is missing
  at reconcile (`ENOENT`) still throws, as does an unexpected `stat` failure.

Not in scope: the `IN_OPEN`-as-read classification in the inotify layer, which
remains a separate change.

## Capabilities

### New Capabilities

None. This narrows an existing requirement in `artifact-manifest`.
