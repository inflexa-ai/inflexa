# Host-side file-tool writes

## Why

The `write_file` and `edit_file` tools write through the sandbox today. The
mutate seam encodes the content as base64, and it runs a `python3 -c` program in
the sandbox to write the bytes (`src/tools/workspace/mutator.ts`). That exec adds
a python dependency, a sandbox round-trip, and startup cost. But it adds no
provenance value: the seam intentionally discards the exec frame, and the
in-process `file_tool` record is the sole attestation. Thus the sandbox gives
containment only, and a hardened host path check can give the same containment.

## What Changes

- The `WorkspaceMutator` seam stays the single choke point, but it writes the
  bytes with the host filesystem after the `resolveForWrite` confinement. The
  change deletes the python-in-sandbox write path.
- The host write gets symlink checks:
  - The seam re-checks the realpath of the deepest ancestor that exists.
  - The seam refuses a final component that is a symbolic link.
  - The seam refuses a symlinked ancestor that escapes the write prefix.
  - The seam makes a parent directory only inside the write prefix.
- The provenance is unchanged: the seam records each write as a `file_written`
  event with `producer: "file_tool"`, and the hashes reconcile from disk, the
  same as today.
- `execute_command` stays sandbox-gated. The sandbox, its mount plan, and the
  read-only analysis mount are unchanged.
- The conversation agent gains `write_file` and `edit_file`, over a
  session-scoped `WorkspaceMutator` realization. Its write prefix is the
  analysis root, thus a chat turn can write each file of its own analysis
  tree. Each successful chat write emits one `write-file` provenance session
  event, with the hash and the size of the exact bytes. The report agent
  cannot write, and `readOnly` mode omits `write_file`/`edit_file`.
- The two file tools keep `executionMode: "workflow"`. The reason is now the
  mutation of durable workspace state inside a workflow, not `DBOS.recv`.
- `edit_file` gains a bulk regex mode: `regex: true` with `expected_matches` or
  `replace_all: true`. On a count mismatch the tool writes nothing and reports
  the actual count and the line numbers of the matches.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `harness-workspace-tools`: `write_file` and `edit_file` write host-side. The
  confinement gains symlink checks. `edit_file` gains the regex mode. The
  file-tool provenance requirement is unchanged. The conversation agent gains
  the write pair, confined to the analysis root, with one provenance session
  event for each successful write.
- `provenance-seam`: the session event union gains a `write-file` member for
  the file write of a conversation turn.
- `harness-tools`: the reason for `executionMode: "workflow"` on the file tools
  changes. The mode itself is unchanged.
- `exec-provenance-lineage`: two scenarios named the sandbox write exec. A
  file-tool write now produces no exec frame at all.
- `sandbox-server`: the body-cap rationale named the `write_file` payloads. The
  cap itself is unchanged.

## Impact

- `src/tools/workspace/mutator.ts` — the host byte-write, the symlink checks,
  the deletion of the `python3 -c` write program, and the session-scoped
  realization for the conversation agent.
- `src/tools/workspace/edit-file.ts` — the regex mode.
- `src/workspace/paths.ts` — `resolveForWrite` keeps the prefix check that the
  symlink checks extend.
- `src/provenance/seam.ts` — the `write-file` session event.
- `src/agents/conversation-agent.ts` — the write pair joins the roster.
- `@inflexa-ai/prov-kernel` — the `session_file_written` event, because
  `file_written` demands a step ref that a chat write does not have.
- The cli provenance bridge — the map from the `write-file` session event onto
  the `prov.session_file_written` bus event.
- Documents: `harness/CONTEXT.md`, `harness/CLAUDE.md`, and the root
  `SECURITY.md` scope the containment claim to command execution.
- Not affected: the sandbox providers, the mount plan, the exec path of
  `execute_command`, and the provenance pipeline of a run.
