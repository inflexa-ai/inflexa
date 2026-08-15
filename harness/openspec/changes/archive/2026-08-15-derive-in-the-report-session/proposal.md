## Why

The runs write statistical tables, and not plot-ready ones. In the first real session the agent could not reshape a table, and the rejected alternative was a display-CSV rule on every run agent. A per-row transform now lives in the renderer, thus the derivation serves real reshaping: a join, a pivot, an aggregate.

## What Changes

- A session-scoped derivation tool joins the Report Builder roster. The agent derives a table from the pinned evidence.
- The derivation runs on the sandbox substrate that exists: the container rails, the resource policy, no network, and the signed exec protocol.
- The mounts differ from a run: the declared pinned inputs read-only, and one write mount under the session `derived/` directory.
- No run id, no ledger entry, and no workspace-tree write. The record lives in the session state: the source hashes, the script hash, the output path, and the output hash.
- The served snapshot merges the derivation records, thus a derived table is bindable and the stored pin stays untouched.
- The purge of a session covers `derived/`.

## The rule that survives

The read-only roster rule stands: no tool starts an analysis run, and no tool changes the analysis. A session derivation does neither. It mints no run id, it registers no artifact, and it writes under the session directory alone.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-session-agent`: the roster gains the derivation tool with the carve-out sentence, and the durable session state gains the derivation record.
- `report-verification`: the derivation is repeatable, because the record pins the script and the sources.

## Impact

- `harness/src/tools/report-session/` — the derivation tool.
- `harness/src/state/report-session-state.ts` — the record.
- `harness/src/app/report-session-runtime.ts` — the merged membership at the load.
- The sandbox rails of `harness/src/tasks/extract-values.ts` are the pattern, and they do not change.
