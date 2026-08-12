## Why

The assembly resolves the eyes of the composition and gives them to the report agent. Nothing carries them to the tool that starts a report session. That tool builds its own spawn with no seam, and it reads its own gate from the chrome config alone. Thus a composition that binds the seam and names no browser holds two gates that disagree. The report agent can look at a page, and the tool refuses with `no_browser`. No session ever starts, and that is the local CLI exactly.

The gap passes the typecheck and every test, because the seam is an optional dep at each layer. Only a composition that binds the seam meets it.

## What Changes

- The conversation agent takes the eyes seam, and the assembly gives it the answer that it resolved already for the report agent. Thus one resolution serves both consumers.
- The start tool takes the seam, and it gives the seam to the spawn that it builds.
- The gate of the tool stops its own reading of the chrome config. The module of the spawn exports the rule as one predicate, and both readers call it. The tool builds the deps of its spawn one time, and it hands that same value to the factory and to the predicate. Thus the two gates cannot disagree.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-session-spawn`: one rule decides whether the composition gives a route to a look, and the spawn and the start tool both read it. The requirement of the tool states that a spawn refusal passes through. Thus a second gate that reads less than the spawn is a defect, and the delta states the one-rule obligation.

## Impact

- `src/runtime/assemble.ts` — the resolved seam reaches the conversation agent.
- `src/agents/conversation-agent.ts` — the deps carry the seam, and the agent forwards it.
- `src/tools/start-report-session.ts` — the deps carry the seam, the spawn takes it, and the gate reads the spawn.
- `src/app/spawn-report-session.ts` — the module exports the rule of the gate as one predicate. No rule of the spawn changes, and its returned interface does not change.
- Out of scope: the realization that gives the CLI a browser.
