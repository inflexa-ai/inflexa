# Harness Integration — Follow-up Program Tracker

Successor to `docs/harness_integration-new/` (which re-verified the research after the
monorepo merge and drove the five-change graph). That program is **complete**: C
(embed-harness-runtime), F (embed-execute-analysis), D (bridge-harness-provenance),
D2 (deepen-run-provenance), and D3 (record-command-lineage) are landed and archived in
`cli/openspec/changes/archive/`; E (remove-custom-provenance-persistence) is **landed and
archived** at `harness/openspec/changes/archive/2026-07-07-remove-custom-provenance-persistence/`.

This folder holds the *forward* discussion: what comes after the program, now that the
issue tracker carries a committed daemon architecture (#33) and its follow-ups. Unlike
the predecessor folders, most of the terrain here is already mapped by issues — these
docs connect them and frame the two decisions that need making, they do not re-research
what the issues already verified.

**Reading order:** 01 (the sandbox recovery wedge — what "#28" loosely refers to, and
why its durable fix is #33's stable-ingress milestone) → 02 (the conversation-agent
adoption research program — the next walking skeleton, and why #33/#36/#32 changed its
shape since `06-change-graph.md` sketched it).

---

## Where the program stands (2026-07-07)

```
landed:   C ──► F ──► D ──► D2 ──► D3 ──► E    (+ resource-budgeted scheduling, 1c8d622)
next:     ┌─ conversation-agent adoption ── needs the research loop in 02
          └─ durability hardening ────────── framed in 01, largely lands via #33 M2
```

## Backlog map — every known open item and its home

| Item | Home | State |
|---|---|---|
| Change E — delete custom prov persistence | `harness/openspec/changes/archive/2026-07-07-remove-custom-provenance-persistence` | landed + archived 2026-07-07 |
| Sandbox recovery wedge (leaked-container recv hang) | #41 (filed from 01 in this folder) | issue filed — observed live 2× |
| Data-profile kill/resume verification | #28 | done — verified live 2026-07-07 (clean resume, `recovery_attempts` 1→2) |
| Linux Docker ingress reachability | #27 | open; proposed bridge-gateway bind |
| Daemon architecture (one runtime, many clients) | #33 | decided + milestoned (M1–M4) |
| State ownership under the daemon | #36 | open; 4 decision areas with recommendations |
| Provenance chain-fork (two recorders, one analysis) | #37 | open bug; structurally closed by #33 M2/M3 |
| Plan-intake reframe (author/replay split) | #32 | postponed — pickup point IS planner adoption (02) |
| Conversation-agent adoption | **02 in this folder** | research program defined, loop not yet run |
| Tool-read lineage gap (`read_file` invisible to lineage) | `harness_integration-new/00-progress.md` §D2 findings | unfiled |
| Tool-write lineage gap (`recordFileToolWrite` uncalled) | change E design D2 names it out-of-scope | unfiled |
| Data-profile + ephemeral lineage coverage hole | `03-provenance-migration-plan.md` open decisions | undecided |
| `summary.md` walk-ordering (unregistered artifact) | #38 | filed |
| Sandbox-step builds full agent catalog per step | #30 | filed (perf) |
| Analysis-inputs UX | #26 | filed |
| `inflexa run` detach messaging overstates Ctrl+C | `harness_integration-new/00-progress.md` §D findings | superseded by #33 M2 attach/detach UX |
| Archive `add-resource-budgeted-scheduling` | `harness/openspec/changes/archive/2026-07-07-add-resource-budgeted-scheduling` | archived (commit 1e5156f) |

## Open user decisions

- [x] Land order — resolved by events: E landed first (2026-07-07, archived), and the
      02 research loop was kicked off the same day.
- [x] File the recovery wedge as its own issue — filed as #41 (supersedes 01's §5
      recommendation), linked from #27 and #33 design-note-5.
- [ ] Whether conversation-agent adoption presupposes #33 M1/M2 (daemon skeleton + run
      engine behind the server) or starts embedded — the sequencing question 02 puts
      first (RQ7).
