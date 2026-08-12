# Default store discovery to the container mount

## Why

Managed Cortex mounts the ref-store PVC into its own pod at `/mnt/refs` and passes `refStorePvc` to the sandbox client, so every sandbox Job receives the store — and every agent is told the store does not exist. `EnvironmentStorePaths.refStorePath` is the only root `list_available_refs` reads; a Kubernetes embedder holds a PVC name, not a host path, so it has nothing to put there; and `scanStore` short-circuits to `unavailable` when the field is absent. The bytes are mounted into the very process that reports them missing, and the planner plans against that report.

The lib store does not have this defect, for exactly one reason: `list_available_packages` falls back to `/mnt/libs/current/packages.txt`. Same topology, same embedder, opposite outcome — one tool has a default and the other does not.

The interface's own prose is what kept them apart. `EnvironmentStorePaths` states that absence must "never [be] papered over with a guessed path", while the `packagesFile` field directly beneath it says to omit the path "when the host mounts the store at the sandbox's own path, which makes the container path correct as-is". Two fields of one interface, opposite meanings for an omitted value, and a rule stated over both that describes only one.

The guess that rule warns about cannot occur here. Every consumer stats its root before it reports anything: `scanStore` lstats and returns `unavailable` on failure, and the packages reader lets `readFile` throw into the unknown-inventory note. A defaulted root with nothing mounted at it yields precisely the answer an omitted path yields. What the rule protects — never report presence you did not verify — lives in that stat, not in the shape of the config field.

## What Changes

- `list_available_refs` resolves its read root as `refStorePath ?? /mnt/refs`, so a host whose own process sees the store where the sandbox does configures nothing.
- `mount-plan.ts` exports `LIBS_CONTAINER_PATH` / `REFS_CONTAINER_PATH`. That file already calls itself the single source of truth for container-side paths, while `list-available-refs.ts` and `list-available-packages.ts` each carried a second copy of one. Both now import.
- `EnvironmentStorePaths` documents one meaning for absence across both fields: the container mountpoint, stat-verified. Supplying a path means naming a location the mountpoint does not describe.
- `scanStore` narrows to `root: string`. Its `if (!root)` branch was the sole producer of the unconfigured-store result and is now unreachable.
- The mount contract is untouched. "When neither `refStorePath` nor `refStorePvc` is configured, the container SHALL receive no `/mnt/refs` mount" still holds — this change is about what the host may read, never about what the sandbox is given.

No behavior change for the CLI or for Cortex's Docker-backed dev mode: both supply explicit paths, and an explicit path still wins.

Out of scope: replacing `packagesFile` with a `libStoreRoot` to collapse the three encodings of `current/packages.txt` across the harness and its embedders. That is a signature change to a field both embedders pass, so it belongs with an embedder bump; this change is deliberately patch-level.

## Capabilities

### Modified Capabilities

- `ref-store`: discovery falls back to the container mountpoint when the embedder supplies no path. The same requirement stops describing the tool as a sandbox-exec call over the sandbox's own filesystem — it has read host-side since it became a planner tool, and that stale sentence is corrected here rather than edited around.

## Impact

Harness source:

- `src/sandbox/mount-plan.ts` — the two container paths become exported.
- `src/tools/sandbox/list-available-refs.ts` — fallback root, imported constant, narrowed `scanStore`.
- `src/tools/sandbox/list-available-packages.ts` — default derived from the shared constant; the value is unchanged.
- `src/config/environment-stores.ts` — the absence contract.

Embedders: no change required. Managed Cortex gains working reference discovery on the next bump with no configuration at all — `REF_STORE_PATH` becomes an override for hosts that read the store somewhere else, rather than a requirement the Kubernetes chart would otherwise have to carry.
