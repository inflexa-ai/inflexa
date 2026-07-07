# Harness Integration — Follow-up Program Tracker

Successor to `docs/harness_integration-new/` (which re-verified the research after the
monorepo merge and drove the five-change graph). That program is **complete**: C
(embed-harness-runtime), F (embed-execute-analysis), D (bridge-harness-provenance),
D2 (deepen-run-provenance), and D3 (record-command-lineage) are landed and archived in
`cli/openspec/changes/archive/`; E (remove-custom-provenance-persistence) is **specced
and apply-ready** at `harness/openspec/changes/remove-custom-provenance-persistence/`
(proposal, design D1–D5, 3 delta specs, 6 task groups — 2026-07-07).

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
landed:   C ──► F ──► D ──► D2 ──► D3          (+ resource-budgeted scheduling, 1c8d622)
specced:  E  (harness deletion + spec hygiene — apply-ready)
next:     ┌─ conversation-agent adoption ── needs the research loop in 02
          └─ durability hardening ────────── framed in 01, largely lands via #33 M2
```

## Backlog map — every known open item and its home

| Item | Home | State |
|---|---|---|
| Change E — delete custom prov persistence | `harness/openspec/changes/remove-custom-provenance-persistence` | specced, apply-ready |
| Sandbox recovery wedge (leaked-container recv hang) | **01 in this folder** — no dedicated issue yet | observed live 2×, unfiled |
| Data-profile kill/resume verification | #28 | open; ~2–5 min procedure written in the issue |
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
| Archive `add-resource-budgeted-scheduling` | `harness/openspec/changes/` | implemented + complete; needs archiving |

## Open user decisions

- [ ] Land order: E first (small, independent), then start the 02 research loop — or run
      the loop while E lands (they share no code). Both defensible; E-first is cleaner.
- [ ] File the recovery wedge as its own issue (01 recommends yes — #28's title does not
      cover it, and #33 design-note-5 only gestures at it).
- [ ] Whether conversation-agent adoption presupposes #33 M1/M2 (daemon skeleton + run
      engine behind the server) or starts embedded — the sequencing question 02 puts
      first (RQ7).
