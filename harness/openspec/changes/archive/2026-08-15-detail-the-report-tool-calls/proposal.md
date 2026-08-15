## Why

The report-session tools show opaque call lines. A user who watches the session cannot tell which section the agent adds, which table it binds, or where the page landed. The detail seam exists, and the report tools give a thin detail or none.

## What Changes

- The detail seam gains an optional result hook. The finished event can recompute its detail from the outcome, and the started detail stays the fallback.
- `add_block` names the kind with its title or its bound file: `add section "Summary"`, or `add table de.csv`.
- `preview_report` names the page path on a pass, and the outcome kind otherwise.
- `record_report_version` names the recorded version. `examine_page` names the look outcome.
- `list_pinned_artifacts` names the listed count, with the truncation.
- `change_block`, `move_block`, and `remove_block` keep the block id that they give.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tool-call-detail`: the seam gains the result hook and the finished-event recompute, under the same guard and the same normalization.
- `report-session-agent`: the session tools give the named details.

## Impact

- `harness/src/tools/define-tool.ts` and `harness/src/loop/tool-detail.ts` — the result hook and its compute.
- `harness/src/loop/run-agent.ts` — the finished-event detail.
- `harness/src/tools/report-authoring/` and `harness/src/tools/report-session/` — the providers.
- The CLI renders the finished detail already, thus no CLI change.
