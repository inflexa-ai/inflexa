## Context

Both write tools funnel their bytes through the single `mutator.writeFile`
chokepoint (`src/tools/workspace/mutator.ts`). Today the seam encodes the
content as base64 and runs a `python3 -c` program in the sandbox. The seam
reads only the exit code of that exec. It intentionally discards the exec
frame, because a `python3` + base64 command record would be a false
attribution. The in-process file-tool record (`recordFileToolWrite`) is the
sole attestation, with hash and size computed from the exact bytes. The
reconcile step rehashes from disk.

`resolveForWrite` (`src/workspace/paths.ts`) already rejects an out-of-tree
path (`out_of_scope`) and an in-tree path outside the working directory
(`out_of_prefix`) before any I/O. The confinement is thus host-side already.
Only the byte-write itself rides the sandbox.

The workspace root resolves to a local path in both deployment topologies. In
the local and docker topology, the root is a host directory. In the k8s
topology, the harness process mounts the session PVC (`sessionPvcRoot`,
`src/sandbox/k8s-client.ts`). Thus the harness process can reach the write
target everywhere.

## Goals / Non-Goals

**Goals:**

- The seam writes the bytes with the host filesystem, behind the unchanged
  `WorkspaceMutator` interface and its data variants.
- The confinement becomes stronger, not weaker: the prefix check stays, and
  symlink checks close the realpath gap.
- The provenance is byte-identical to today: a `file_written` event with
  `producer: "file_tool"`, and hashes that reconcile from disk.
- `edit_file` gains a bulk regex mode with an explicit match contract.

**Non-Goals:**

- No change to `execute_command`, to the sandbox, to its mount plan, or to the
  read-only analysis mount.
- No change to the agent rosters. Only a sandbox agent holds the mutate
  surface, and `readOnly` mode still omits the write pair.
- No change to the shape of a provenance record or a run event.

## Decisions

**1. The sandbox gave containment, not provenance, to file-tool writes.** The
seam never fed the write exec frame to the collector — the suppression was
deliberate. The attestation always came from the in-process record, and the
hashes always reconciled from disk. Thus the only value of the sandbox exec
was the write inside the container mounts. A hardened host path check gives
the same containment, without the python dependency and without the startup
and exec cost.

**2. Confinement moves to a hardened host path check.** `resolveForWrite`
keeps the prefix check. The write path adds four symlink checks:

- The seam finds the deepest ancestor of the resolved path that exists, and it
  compares the realpath of that ancestor against the write prefix.
- The seam refuses a final component that is a symbolic link.
- The seam refuses a symlinked ancestor whose realpath escapes the write
  prefix.
- The seam makes an absent parent directory only inside the write prefix.

Rejected: trust in the prefix string alone. A symbolic link that an earlier
exec wrote can turn an in-prefix string into an out-of-prefix target.

**3. The seam stays the single choke point.** Resolve, confine, write, and
record stay behind `WorkspaceMutator.writeFile`. A future file tool cannot
skip the confinement or the provenance by construction.

**4. The host write works in both deployment topologies.** Locally the
workspace root is a host directory. In k8s the harness process already mounts
the session PVC (`sessionPvcRoot`). Thus no new mount and no new privilege is
necessary for the host write.

**5. The file tools keep `executionMode: "workflow"`.** The old reason was
`DBOS.recv`, which the host write no longer uses. The mode stays because each
write mutates durable workspace state inside a workflow. `execute_command`
keeps the mode for the old reason, because it still receives its result with
`DBOS.recv`.

**6. The regex mode demands an explicit match contract.** A regex call carries
`expected_matches` (an exact count) or `replace_all: true`. On a count
mismatch the tool writes nothing, and it reports the actual count and the line
numbers of the matches. A bulk edit without a declared count can silently
rewrite the wrong places. The contract makes the model state its intent, and
the mismatch report lets it correct.

## Risks / Trade-offs

- [A symbolic link appears between the realpath re-check and the write] → The
  only writer inside the step prefix during the write is the step itself. Thus
  the race needs the agent to attack its own write, and the checks refuse
  every persistent escape form.
- [The harness uid differs from the sandbox uid] → The file mode of a new file
  must let the sandbox user read it. The tests make sure that a script reads a
  file that `write_file` wrote.
- [A host write no longer needs a live sandbox] → The rosters are unchanged,
  thus no new caller appears. The observable surface of each agent is the same
  as today.

## Migration Plan

No event-shape, schema, or storage change. Old runs replay against the same
data variants. The rollback is a revert to the sandbox write path.

## Open Questions

_None._
