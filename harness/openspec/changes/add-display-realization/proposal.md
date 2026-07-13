# Proposal — display realization (harness side)

Companion change: `cli/openspec/changes/add-display-realization` (the CLI
realization of these contracts). This harness change carries the contract
work; the CLI change consumes it.

## Why

The CLI is about to grow first-class renderers for the display-card family
(`data-presentation`, `data-file-reference`, `data-preview`), which today it
collapses to `[part:…]` mentions. Before renderers are born against the
contract, two contract-level gaps need fixing: `data-preview` names a
mechanism instead of its content (every sibling part is a content noun —
`data-plan`, `data-file-reference`, `data-presentation`), and `show_user`'s
`echart` kind can only chart data the agent inlines through its context
window — there is no way to chart an existing artifact (e.g. a chart-ready
CSV a sandbox step produced) by reference.

## What Changes

- **BREAKING** — rename the chat parts `data-preview` → `data-report-preview`
  and `data-preview-failed` → `data-report-preview-failed` across the
  contracts (`chat-parts.ts`, zod schemas, `part-registry.ts`), the emit sites
  (`iterate-report.ts`, `submit-report.ts`), and the reconstruction path
  (`card-builders.ts`, `reconstruct-cards.ts`). Breaking only for external
  consumers of the contracts barrel (the react-client); there is no stored-data
  migration — cards are never persisted, they are reconstructed from
  `iterate_report` tool_use blocks, so old transcripts reconstruct under the
  new name automatically.
- Extend `show_user`'s `echart` kind with an optional `dataPath` — an
  analysis-rooted artifact path (same validation rules as `show_file`) naming
  a CSV the *host* loads and injects as the ECharts `dataset.source` at render
  time. The agent authors `dataset`/`encode` against column names and never
  pulls the data through its context window. Inline-data specs stay legal.
- Add the artifact-sourced discipline to the `echart-layout` agent checklist:
  when a chart-ready artifact exists, reference it via `dataPath` and encode by
  column name instead of inlining rows.

## Capabilities

### New Capabilities

- `display-cards`: the display-card contract — cards carry semantic references
  (paths, ids, specs), never bytes; hosts resolve references to viewable
  content at render time. Homes the `show_user` `dataPath` requirements and
  the host-side CSV resolution conventions.

### Modified Capabilities

- `iterative-report`: the preview part names change to `data-report-preview` /
  `data-report-preview-failed` (requirements "Pre-flight stages sources and
  cross-checks creation briefs" and "submit_report is the postcondition gate
  and emits the preview part").
- `echart-layout`: new agent-checklist requirement for artifact-sourced charts
  (`dataPath` + `dataset`/`encode` by column name).

## Impact

- `src/contracts/chat-parts.ts`, `src/contracts/schemas/chat-parts.ts`,
  `src/contracts/part-registry.ts`, `src/contracts/message.ts` (doc example)
- `src/tools/iterate-report.ts`, `src/tools/report/submit-report.ts`
- `src/tools/display/show-user.ts` (schema + validation),
  `src/tools/workspace/show-file.ts` (path validation becomes shared)
- `src/memory/card-builders.ts`, `src/memory/reconstruct-cards.ts`
- Conversation-agent prompt's "ECharts Layout" section (mirrors `echart-layout`)
- External: react-client consumes the contracts barrel and must follow the
  rename; the CLI change consumes both the rename and `dataPath`.
