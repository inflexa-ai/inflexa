## Why

A hard delete of a thread erases the rows of its whole subtree, and it gives back nothing. A report session owns a page tree on disk, and that tree stays. Its directory is named by a thread id that no longer exists, thus no surface can name it again. A host that wants to reclaim those bytes has no way to learn which ones to remove.

The layout of that tree is also unnamed. The workspace layout enumerates `data/`, `runs/`, `reports/`, and `previews/`, and it omits the report-session tree. Two tool modules compose the path by hand, thus the layout lives in the tools and not in one place.

## What Changes

- `purgeThread` gives back the thread ids that it erased. The recursive walk already computes that set, thus the value costs one read of what the transaction already names.
- The workspace paths gain one helper for the directory of a report session. The preview tool and the page-examination tool use it, and neither composes the layout again.
- The workspace layout names the report-session tree beside the other four.
- The front door carries the helper, because an embedder that removes the files must not restate a path of the harness.

## Capabilities

### Modified Capabilities

- `harness-thread-store`: `purgeThread` gives back the erased thread ids instead of nothing.
- `workspace-layout`: the report-session tree enters the layout, and one helper composes its path.

## Impact

- `src/memory/thread-store.ts` — the return of `purgeThread`, and the read of the subtree that feeds it.
- `src/workspace/paths.ts` — the directory helper, beside `previewDir`.
- `src/tools/report-session/preview-report.ts` and `src/tools/report-session/examine-page.ts` — each calls the helper.
- `src/app/spawn-report-session.ts` — it purges a child that holds no turn. A wider return changes no behavior there.
- `src/index.ts` — the helper reaches an embedder.
