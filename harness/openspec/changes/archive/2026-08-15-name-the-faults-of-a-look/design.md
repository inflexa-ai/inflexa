## Context

`capturePage` (`lib/page-capture.ts`) navigates, waits for the readiness signal, and screenshots. The page reveals its sections through a `fade-in` transition, and the design CSS collapses every transition under `prefers-reduced-motion` (`report-render/design.ts`). The report-session prompt teaches the look inside its verification section, and it names no concrete fault.

## Goals / Non-Goals

- Goal: the capture reads a settled page, with no mid-fade content.
- Goal: the agent judges the picture against a named fault list, thus a visible defect cannot pass as clean.
- Non-goal: a mechanical layout check. The judgment stays with the agent, and the tool blocks nothing.

## Decisions

- **The settle is reduced-motion emulation.** The capture emulates `prefers-reduced-motion: reduce` before the navigation, thus the design CSS shows every element at once and no transition runs. The alternative was a fixed settle delay, and it was rejected: a delay is a race, and the emulation is a contract with the design source.
- **The checklist lives in the prompt, in the look step.** The faults are judgment work over a picture, thus they belong to the agent guidance and not to the tool result. The list names: clipped text, a truncated number, an overflowing card, a raw column name on an axis, an unreadable precision, and content that a fade left invisible.
- **The emulation sits in `capturePage`.** Both capture sites read one body, thus the old preview path and the eyes settle the same way.

## Risks / Trade-offs

- [The emulation hides a motion defect] → the page is a document, and its motion is decoration. A defect of the settled layout is the defect that matters.

## Open Questions

None.
