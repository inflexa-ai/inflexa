## Context

The eyes seam answers where a browser comes from for one look. The assembly resolves it one time and gives it to the report agent (`src/runtime/assemble.ts:328`).

Two consumers read the availability of the eyes. The spawn refuses a session that can never record a version, and its gate reads three routes: the seam, the capture seam, and a chrome config that names a browser (`src/app/spawn-report-session.ts`). The start tool refuses before it runs its advice reads, and its gate reads the chrome config alone (`src/tools/start-report-session.ts:170`).

The requirement of the tool already states the intent: a spawn refusal passes through as typed data. The tool holds its own gate for one reason. The advice costs two database reads, and a closed gate must skip them. The gate is an optimization, and it was never meant to be a second rule.

## Goals / Non-Goals

**Goals:**

- One composition answer reaches the report agent and the start tool.
- The gate of the tool and the gate of the spawn cannot disagree.
- The change stays additive at each seam, thus no embedder breaks.

**Non-Goals:**

- The realization that gives the CLI a browser.
- Any rule of the spawn. Its gate is correct already.
- A capture dep on the start tool.

## Decisions

### D1. One predicate holds the rule, and one deps value feeds both readers

The tool could hold a copy of the expression of the spawn. That shape produced the defect: two places held one rule, and one of them fell behind. The module of the spawn now exports the rule as a predicate over the deps that name the routes. The spawn calls it, and the tool calls it.

The drift risk of two call sites is the passing of two different deps values. The tool closes that by construction. It builds the deps of its spawn one time, as a value, and it hands that same value to the factory and to the predicate. Thus the gate of the tool reads the routes of the very spawn that would refuse.

A read-only member on the returned operation was the other option. It binds the two even more tightly, but it widens a public interface for an optimization of one caller. A later route reaches both readers through the predicate with no interface change, thus the lighter shape gives the same guarantee.

### D2. The start tool takes no capture dep

The gate of the spawn reads three routes, and the tool binds only two of them. The capture seam replaces the transport of the eyes tool, and it exists for a test of that tool. The start tool never captures a page.

The asymmetry costs nothing, because the tool reads the answer of the spawn and it names no route itself. A composition that binds a capture seam directly to the spawn still opens the gate.

### D3. The assembly resolves one time

`resolveCompositionEyes` runs once in the assembly, and its answer reaches the report agent and the conversation agent. A second resolution would let one consumer see a different precedence.

### D4. The predicate stays off the barrel

`createReportSessionSpawn` is on the barrel, and `compositionHasEyes` is not. The harness exports a name that a consumer outside it calls. No embedder calls this gate. The spawn refuses on its own, and the predicate exists so one in-harness caller can skip two database reads.

An export would also make the rule a public name. A later route would then change what an embedder reads, and a public name costs a deprecation. Thus the absent export is correct, and the refusal of the spawn stays the one public answer.

## Risks / Trade-offs

- [The tool reads a rule of the spawn module, thus the two couple more tightly] → That coupling is the point. The tool exists to run that spawn, and a refusal of that spawn is its own outcome.
- [A hand-built composition can still bind the seam to one consumer alone] → The assembly wires both, and it passes one value. An embedder that builds the tool by hand owns its own consistency.
- [The predicate takes a deps value, thus a caller can still build two] → The tool builds one value and hands it to both. A reviewer reads that at one place in the factory.

## Migration Plan

The change is additive at each seam. No consumer breaks, and a composition that binds no seam behaves as it does today.

## Open Questions

None.
