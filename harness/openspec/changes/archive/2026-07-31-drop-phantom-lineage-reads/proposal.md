## Why

A customer's `bulk-transcriptomics-agent` step ran for twelve minutes, finished
its work, and was then killed by its own bookkeeping:

```
[reconcile-manifest] cannot attest input — not present at reconcile
  path:      /{rid}/runs/{run}/T1S1/scripts/hashtable_class_helper.pxi
  source:    upstream   refStepId: T1S1
  hostPath:  .../analyses/stroke/runs/{run}/T1S1/scripts/hashtable_class_helper.pxi
  throwSite: input-enoent
```

`hashtable_class_helper.pxi` is a pandas Cython source file. No such file has
ever existed in that directory, and the step never tried to read one. What
happened is CPython's traceback printer, and it is reproducible in three lines:

- A script the step ran lives in `T1S1/scripts/`, so `sys.path[0]` is that
  directory — inside the analysis mount, and inside a *declared dependency's*
  subtree.
- The script died with an uncaught `KeyError` from pandas. Displaying that
  traceback means showing the source line of every frame, and a Cython frame's
  `co_filename` is relative (`hashtable_class_helper.pxi` — the name in the
  `include` directive). CPython's `_Py_FindSourceFile` resolves a relative frame
  filename by *opening* `<entry>/<basename>` for **every** `sys.path` entry until
  one succeeds.
- `sitecustomize.py`'s audit hook fires on the `open` **audit event**, which
  CPython raises *before* the open is attempted. Every failed probe is therefore
  reported exactly like a successful read, `os.path.abspath`-ed against the
  process cwd.

Verified against the shipped hook, unmodified — a script that only crashes with
`df["missing_column"]` emits:

```
{"p": ".../runs/RUN/T1S1/scripts/hashtable_class_helper.pxi", "layer": "python", "op": "read"}
{"p": ".../runs/RUN/T1S1/scripts/index.pyx",                  "layer": "python", "op": "read"}
```

The path classifies `upstream` (T1S1 was declared), which is attested, so
`fillInputHashesFromDisk` stats it, gets `ENOENT`, and throws. The step dies with
`lineage_attestation`, and the parent's fail-fast cascade takes the run — over a
file that never existed, after the analysis had already succeeded. The failure
also *masks* the script error the agent had already recovered from.

This is the third instance of one shape: reconcile treating "a capture layer
named something I cannot hash" as drift worth killing an analysis over. The two
prior instances (`/{resourceId}/..`, out-of-mount reads) were fixed by dropping;
the `ENOENT` throw was explicitly retained then as "genuine drift". That premise
is what is wrong. **The capture layers report attempted operations, not completed
ones** — the Python audit hook fires ahead of the open, R's `trace()` at call
entry over a `normalizePath(mustWork = FALSE)` name — so a read that failed
arrives indistinguishable from one that succeeded. An absent path is therefore
at least as likely to mean *nothing was read* as *an artifact vanished*, and
neither is attestable. Only the LD_PRELOAD layer gets this right today: it
reports after the call, gated on `fd >= 0`.

Nothing about failing recovers the edge. The step has already run; the outputs
are already on disk. Dropping upholds the invariant that matters — never register
a hashless lineage edge — and leaves a warn record and a counter where a dead run
used to be.

## What Changes

- `fillInputHashesFromDisk` SHALL **drop** a tracked input whose path is not
  present at reconcile (`ENOENT`) via `collector.dropInput(ref)`, logged at warn
  with the ref, its resolved `hostPath`, and `dropSite: "input-enoent"`, and
  counted on `cortex.artifact.reconcile.input_dropped` with `reason: "missing"`.
  It no longer throws for this condition.
- Fail-fast is retained for a `stat` that fails any **other** way: the file is
  there and cannot be read, which says something is wrong with the tree itself.
- Sandbox-side, `recordOp` — where all four layers converge — SHALL drop a
  `read` report whose path is not present, so a probe never reaches the frame in
  the first place. Only absence drops it: a `stat` failing any other way keeps
  the report rather than losing a real edge to a transient error. Writes and
  deletes are exempt; a write is reported before the file it creates exists.

The two fixes are independent by design, as in the prior change: the harness one
ships via npm and holds on any sandbox image, which matters because the image is
`workflow_dispatch`-only and `:latest`-tagged.

## Capabilities

### New Capabilities

None. This narrows existing requirements in `artifact-manifest`,
`sandbox-provenance-tracking`, and `exec-provenance-lineage`.
