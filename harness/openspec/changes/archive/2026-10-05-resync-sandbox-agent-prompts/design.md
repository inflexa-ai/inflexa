# Design: resync-sandbox-agent-prompts

## Context

A sandbox agent prompt summarizes its packs: the API references, the method
recommendations, and the scope. The pack is the layer that holds the work and
its contract (root `CLAUDE.md`, "Agent-facing content"). No validation reads
the prose, thus a drifted summary stays green until an agent acts on it.

## Goals / Non-Goals

**Goals:**

- Each of the five prompt summaries states only what its packs hold.
- Each availability caveat of a pack survives into the prompt, or the
  recommendation leaves the prompt.

**Non-Goals:**

- No pack content changes. A gap in a pack is a different change.
- No mechanical validation of prompt-pack agreement. Review stays the
  control, and the new requirement gives review its target.
- No roster changes.

## Decisions

- **The pack wins each conflict.** The pack is the contract layer, and the
  prompt is the mechanism layer. Example: the microbiome pack puts shotgun
  profiling upstream by design. Thus the prompt drops MetaPhlAn and HUMAnN,
  and the pack does not gain them.
- **Five prompts, not three.** The roadmap counted three. A full comparison
  found the same fault in `dna-methylation-agent.ts` and `network-agent.ts`.
  The fix is the same mechanical pass, thus one change covers all five.
- **The requirement lands in `agent-skill-assignment`.** That spec already
  owns the relation between an agent and its packs. A new capability for one
  prose rule was rejected as too small to stand alone.

## Risks / Trade-offs

- [Each edited prompt invalidates its prompt-cache prefix] → One cache write
  for each of the five agents, one time.
- [A future edit drifts again] → The new requirement gives a review target.
  Mechanical enforcement stays out of scope, per the root `CLAUDE.md`.
