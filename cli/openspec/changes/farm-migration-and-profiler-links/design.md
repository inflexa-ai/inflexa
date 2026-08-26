# Design: farm-migration-and-profiler-links (cli side)

## Decision: the missing farm is the discriminator

A one-time migration pass at first boot was rejected. It enumerates analyses,
it needs an upgrade hook, and it runs work for analyses that no one opens
again. The on-demand rule does the work at the next use of each analysis, and
it needs no version stamp. The rule is sound only with the companion change:
creation makes the empty farm eagerly, thus "missing" can only mean
pre-release, or a hand-deleted farm that heals safely.

## Decision: "everything" is the catalog closure, not the pool

The pool shelves many versions per name, and a farm takes one per name. The
catalog farm is the resolved one-per-name view that the build published, thus
its closure is the correct full set. `readFarmClosure` reads it, and the
composition links the closure of the current catalog through the existing
staging swap — crash-safe.

## Decision: the missing farm is the schedule

A repair queue was rejected. The pre-release state is durable, because the
farm is absent, thus no second record can go stale beside it. The bus is
in-process, and the transfer subprocess cannot signal the TUI. Thus the
transfer poll of the open session is the landing signal, and the resolver
stays the backstop for a sandbox that no open preceded.

## The T2 wiring

The profile deps of the harness gain the extension seam, and the cli passes
the same `linkPackagesIntoFarm` realization it binds for the step agents
(`runtime.ts`, the `extendAnalysisFarm` line). The link runs without an ask,
per decision 25 of the record — the analysis consent covered the store at
setup.
