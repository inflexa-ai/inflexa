## Context

Two facts shape this change. First, the only attribution gap the recorder can *see* today is the unresolvable script path: `appendCommandExecuted` recovers a script's hash by matching `command.scriptPath` against the group's own outputs or inputs, and when it matches neither it skips the `used` edge entirely (`document.ts` — deliberately, to avoid minting an unkeyable dangling entity). The skip is correct; its silence is the defect — nothing in the stored document records that an attribution was lost, so no renderer can surface it.

Second, the lineage renderer is attribute-driven end to end: `activityMeta` reads rendering facts off element attributes (`inflexa:command`, `inflexa:tool`, …), `formatTree` words empty branches per activity kind, and `formatDot`/`formatMermaid` derive from `formatJson`'s flat projection. A new activity attribute therefore flows to every output format through the existing seams, no new plumbing.

Related but distinct: harness change `record-file-tool-write-lineage` (Gap 2) makes `file_tool` activities actually appear in new documents. This change's wording work is worthwhile independently — `file_tool` records are already spec'd in `prov-run-events` and rendered by `lineage.ts`; only their absence wording is indistinguishable from a command's today.

## Goals / Non-Goals

**Goals:**
- The unresolved-script gap becomes graph data (`inflexa:unresolvedScript` on the command activity), recorded deterministically and replay-idempotently.
- Lineage output distinguishes three absence kinds: hedged absence (command with no recorded inputs), by-design absence (agent-authored file-tool write), and attribution gap (unresolved script) — with a trailing count so a reviewer can't miss that the tree understates.
- Old documents render exactly as today.

**Non-Goals:**
- Counting bridge-side drops (phantom self-reads, hash-less refs): those are spec'd fail-fast/drop semantics in `prov-harness-bridge`, and surfacing them would require carrying counts through the bus event shapes — a contract change out of proportion to Gap 3. Revisit if a real gap class shows up there.
- Read-lineage coverage (issue #75 Gap 1, postponed): a note cannot count reads that were never observed; the hedged "no recorded" wording remains the honest ceiling for that gap.
- Any harness-side change.

## Decisions

**1. Record the gap at document-build time as an activity attribute, not detect it at render time.** The renderer walks the stored graph; reconstructing "a script should have been here" from the command string at render time re-derives what the recorder already knew and breaks on quoting/interpreter variants. The recorder has the fact in hand at the exact skip site — stamp `inflexa:unresolvedScript: <analysis-scoped script path>` on the activity. Deterministic (pure function of the event payload), so DBOS re-emission writes the identical attribute and `unified()` dedups; a mixed old/new re-emission unions attributes cleanly, the same multi-value semantics input entities already rely on.

**2. Still no dangling entity, no `used` edge.** The no-dangle rule is right: an unresolvable script has no `(path, hash)` key, and a hash-less entity would corrupt the shared QName space. The attribute is metadata about the activity, not a graph node.

**3. Per-kind absence wording in `formatTree`.** The empty-input label branches on `activity.kind`, which `activityMeta` already computes from `prov:type`: `file_tool` → "agent-authored — no file inputs by design" (a positive claim: the recorder attests these bytes came from the agent, not from unobserved reads); `command` → the existing hedged "no recorded inputs". The step-grain wordings are untouched.

**4. Inline gap line + trailing count, both derived from rendered activities.** The unresolved script prints as a child line under its activity (where the reader's eye is when judging that command's inputs) — visually distinct from real input files. The tree footer prints one note ("N attribution gap(s): script paths that resolved to no recorded file") counting `inflexa:unresolvedScript` occurrences among activities the render actually visited — counting the whole document would report gaps the user isn't looking at. No note when the count is zero: the common case stays clean. Rejected: a always-on completeness disclaimer — it would train readers to ignore it.

**5. JSON carries the field; dot/mermaid inherit.** `LineageActivity` gains `unresolvedScript?: string`; `formatJson` exposes it on activity nodes (tree/JSON parity is an existing spec requirement); `formatDot`/`formatMermaid` read the flat projection and append a marker to the activity label. No format-specific logic beyond labels.

## Risks / Trade-offs

- [Attribute name choice is permanent once signed documents carry it] → `inflexa:unresolvedScript` follows the existing `inflexa:` vocabulary style (`inflexa:tool`, `inflexa:command`); the value is the same analysis-scoped path `scriptPath` would have carried, so it can be upgraded to a real edge later without losing information.
- [A resolved-script document re-emitted alongside an old unresolved-script record could carry both the attribute and a script `used` edge] → Harmless: the edge is the stronger claim and the renderer prefers it; the note counts only rendered activities whose attribute has no accompanying script edge — implementation detail pinned by a test.
- [Wording churn in tests that assert exact tree output] → Accepted; the wording IS the deliverable.

## Migration Plan

None. Additive attribute + rendering change; old documents lack the attribute and render as before. Rollback is reverting the change — documents written meanwhile keep an inert extra attribute that old renderers ignore.

## Open Questions

_None._
