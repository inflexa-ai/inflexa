## Context

The detail seam computes one line from the input at dispatch (`loop/tool-detail.ts`), and the finished event echoes the started detail (`contracts/chat-events.ts`). The page path, the recorded version, and the listed count are outcomes, thus no input hook can name them. The CLI part update takes a present finished detail, and it never blanks on an absent one. Thus a richer finished detail reaches the line with no CLI change.

## Goals / Non-Goals

- Goal: a watcher reads what the agent touches and what a call produced, from the call line alone.
- Non-goal: a payload channel. The result hook rides the same guard, the same normalization, and the same length cap.
- Non-goal: a CLI change.

## Decisions

- **The seam gains an optional `describeResult` hook.** It takes the parsed input and the ok-channel result, and it gives a string. The same three rules bind it: synchronous, pure, and never able to fail a call. The finished event carries the recomputed detail when the hook gives one, and the started detail otherwise.
- **The hook runs only on an ok outcome.** An error outcome keeps the started detail. The error already names itself, and a hook over a failed call reads a shape that does not exist.
- **The compute lives beside `computeDetail`.** One module keeps the guard, the parse discipline, and the normalization in one auditable path. The result is not re-parsed: the tool produced it one line above, thus the value is trusted shape-wise, and the hook stays inside the try guard.
- **The providers stay small.** `add_block` reads the kind with the title of a section, or the file name of a bound path. `preview_report` gives `page <path>` on a render and the outcome kind otherwise. `record_report_version` gives the version. `examine_page` gives the look outcome. `list_pinned_artifacts` gives the count with the truncation. The `"none"` sentinel extends to the result side: an empty-input tool with a result hook is representable.

## Risks / Trade-offs

- [A result hook leaks a long value] → the emit-site normalization caps and redacts the result detail the same as the call detail.

## Open Questions

None.
