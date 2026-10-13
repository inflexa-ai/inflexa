# Fix the defects of the local server routes and the reads (#631)

## Why

Issue #631 reports five defects in the routes of the local server and in the reads of the TUI. Four of them still occur at `main`:

- A bare hex prefix does not address a file in the lineage.
- A read of the sandbox readiness hides the cause of the next profile refusal.
- An input removal stops at the first failure.
- The busy read of the TUI records a sighting, but it is not an open.

## What Changes

- **The lineage hash reference.** A stored hash has the form `sha256:<hex>`. The resolver of a lineage reference matches the hex digest of each hash, with or without the scheme. The 6-character minimum of a prefix counts the characters of the digest. Thus the scheme alone (`sha256`, `sha256:`) matches no file.
- **The short hash of a label.** The tree, dot, and mermaid labels show the first 12 characters of the digest, with no scheme. Thus a person can copy that label as a prefix.
- **The sandbox readiness read.** `GET {A}/sandbox-readiness` reports a recorded failure of the farm composition, but it does not clear the record. The sandbox gate of a profile drive continues to clear the record when it reads it. Thus the next profile refusal names the cause.
- **The input removal route.** `POST {A}/inputs/remove` tries each matched input, also after a removal fails. When a removal fails, the route answers 500 `internal_error` after the loop. The message names each input that failed and each input that the route removed.
- **The busy read of the TUI.** The read of `GET {A}` before a rename dialog or a delete dialog sends `touch=false`. Thus it records no sighting of the anchor folder.
- **The `/gui/` page.** No change. Commit `2e363dd8` (#634) made `/gui/` a page of each build channel, and the `local-server` spec now requires that. The code and the spec agree.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `prov-lineage`: a hash reference and a hash prefix match the digest with or without the scheme, and the minimum of a prefix counts the digest characters.
- `local-server`: the sandbox readiness read does not clear the recorded farm failure, and the gate of a profile drive clears it.
- `analysis-input-management`: the removal route tries each matched input, and it reports each failure.

The busy read of the TUI needs no delta. `context-resolution` already requires `touch=false` for a read of `GET {A}` that is not an open.

## Impact

- `src/modules/prov/lineage.ts`: `resolveLineageRef` and `shortHash`.
- `src/server/sandbox_gate.ts` and `src/modules/libs/composition.ts`: a read of the failure record that does not clear it.
- `src/server/routes/analyses.ts`: `POST {A}/inputs/remove`.
- `src/tui/commands.tsx`: `workspaceBusyReason`.
- The stale comments that say the readiness read consumes the record: `src/api/runs.ts` and `src/tui/hooks/sandbox_gate.tsx`.
- No wire type changes. No new dependency. No migration.
