## Context

The report-session prompt (`prompts/report-session.ts`) teaches the tools, the grounding, the path-only rule, the citations, and the look. It carries no obligation about the shape of the story, the choice between a chart and a figure, or the headline set. The agent showed that it knows the better metric set when asked, thus the gap is obligation and not capability.

## Goals / Non-Goals

- Goal: the report reads as one argument, and the evidence illustrates the prose.
- Goal: the native chart replaces a foreign PNG wherever a table artifact holds the data.
- Goal: the headline row orients the reader before any effect size.
- Non-goal: a mechanical check of the narrative. The obligations are prompt guidance.
- Non-goal: a change to the run agents or to the sandbox standards. The run phase keeps its own plots.

## Decisions

- **The spine is an explicit pre-composition step.** The prompt tells the agent to compose the outline before the first block. A spine that exists before the tree prevents the folder-of-results shape, and the outline tools make the order cheap to change.
- **The chapter names stay out.** The prompt states the flow and bans the literal headings, because the issue decided a paper feel and not a paper template.
- **The chart-first rule names the decision input.** The choice reads the pinned listing: a table artifact with the columns of the story prefers a chart block. A PNG stays for what no table carries.
- **The headline obligations name the set.** Cohort and yield first, no caveated value as a headline, contrast inside the card set, and prose that rounds as the cards round. The renderer formats both surfaces with one helper, thus the rounding rule costs the agent nothing.
- **The anti-pattern list extends.** Three entries: evidence before its sentence, a figure where a table serves, and a caveated headline.

## Risks / Trade-offs

- [A longer prompt costs each turn] → the three obligations are compact, and the cached prefix carries them one time.

## Open Questions

None.
