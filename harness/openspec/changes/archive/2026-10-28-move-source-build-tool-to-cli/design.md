# Design

## Context

The design of the move is in the sibling CLI change `move-source-build-tool-to-cli`, in `cli/openspec/changes/`. This document gives the harness side alone.

## Goals / Non-Goals

**Goals:**

- The harness has no build-session type, no `install_from_source` tool, and no spec text for them.
- The harness gets no new export.

**Non-Goals:**

- No change to the farm lock `source` field (`src/sandbox/farm.ts`), to `r/source` on `R_LIBS_SITE` (`src/sandbox/mount-plan.ts`), or to the `source` track of `list_available_packages`. The harness sandbox reads these store shapes for each package, and a source-built package is one of them.
- No change to the loop cut. The CLI tool depends on it as it is.

## Decisions

### D1: Remove, do not deprecate

The harness never published `BuildSession`, thus no consumer outside this repository depends on it. The CLI is the only consumer, and the same change removes its use. Thus the harness removes the types, the tool, and the dependency with no transition.

### D2: The sandbox roster test loses its tool assertion

`src/agents/sandbox/test/shared.test.ts` asserts that the sandbox roster holds no `install_from_source`. After the move, the harness does not know the tool. The sandbox roster takes no host tool, thus the assertion goes away.

### D3: The capability retires at the archive

The delta removes each requirement of `source-build-session`. OpenSpec then removes the spec file at the archive.

## Risks / Trade-offs

- [The CLI reads the harness through `dist/`.] → Build the harness after the removal, then run the CLI typecheck.
