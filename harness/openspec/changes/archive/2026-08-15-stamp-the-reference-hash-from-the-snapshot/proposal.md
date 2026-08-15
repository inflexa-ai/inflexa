## Why

An artifact reference requires a content hash, and no tool gives one. In the first real session the agent probed: it added a block with a wrong hash, read the correct hash from the mismatch refusal, and removed the block. About 20 tool calls went to this hunt. The pinned snapshot already maps each artifact path onto its hash.

## What Changes

- A reference can carry the path alone. The land path of `add_block` and `change_block` stamps the absent hash from the pinned snapshot.
- An unknown path refuses at the stamp, and the refusal names the path. An explicit stale hash keeps the `hash-mismatch` arm, for a draft that predates a re-pin.
- A new tool on the report roster lists the pinned artifacts: the path, the hash, the file type, and the columns of a tabular artifact.
- The report-session prompt names the listing tool as the orientation source, and it states the path-only rule.
- The `add_block` and `change_block` descriptions teach the omission of the hash.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-authoring`: a new requirement gives the hash stamp of the land path, with the unknown-path refusal and the mismatch arm.
- `report-session-agent`: the read-only roster gains the listing tool, and the prompt obligations gain the orientation source.

## Impact

- `harness/src/report-model/` — the stamp walk, wired into the add and the change operations.
- `harness/src/tools/report-session/` — the listing tool, exported and on the roster.
- `harness/src/tools/report-authoring/authoring-tools.ts` — the two tool descriptions.
- `harness/src/prompts/report-session.ts` — the orientation source and the path-only rule.
- No contract schema change, and no store change.
