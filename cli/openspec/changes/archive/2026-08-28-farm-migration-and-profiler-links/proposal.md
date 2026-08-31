# Proposal: farm-migration-and-profiler-links

## Why

A pre-release analysis has no farm, and the resolver heals a missing farm as
an empty one at the first sandbox. The old images carried every package, thus
the upgrade silently starves every existing analysis. New analyses also lack
a farm until their first sandbox, thus "missing" alone cannot say "old".

## What Changes

- Analysis creation makes the empty farm eagerly, with its lock, before the
  profile trigger. Every post-release analysis then carries a farm from
  birth, and a missing farm becomes the pre-release discriminator.
- The farm resolver composes a FULL farm from the catalog closure when the
  farm is missing, on demand, through the existing staging swap. A
  pre-release analysis thus keeps the everything-available behavior of the
  old images. A present farm stays untouched.
- The profile deps carry the same `linkPackagesIntoFarm` realization that the
  step agents use, thus the profiler links a reader by need. The harness
  change of the same name owns the behavior.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `package-store-management`: the eager empty farm at creation, and the
  on-demand full composition for a farm-less analysis.
- `farm-composition`: the same two behaviors, on the requirement that held
  the heal-empty rule. A failed farm make stops the creation, and a
  missing farm heals full.

## Impact

- `src/modules/harness/runtime.ts`: the resolver heal changes from empty to
  full, and the profile deps gain the extension seam.
- The analysis-creation flow makes the farm before the profile trigger.
- `src/modules/libs/composition.ts`: a full-farm composition from the catalog
  closure, reusing `readFarmClosure` and the staging swap.
