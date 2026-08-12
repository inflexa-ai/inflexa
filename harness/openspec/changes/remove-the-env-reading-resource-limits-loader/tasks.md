## 1. Delete the loader

- [x] 1.1 Confirm `loadResourceLimits` has no caller in the harness, the CLI, or managed Cortex, and is not re-exported from `src/index.ts`.
- [x] 1.2 Delete `loadResourceLimits` and the two parsing helpers it alone used (`parsePositiveNumber`, `parseNonNegativeInt`).
- [x] 1.3 Leave `ResourceLimitsConfigError`, the schemas, `clampResources`, and `parseResourcePolicy` intact — `parseResourcePolicy` still raises the same error type for an invalid embedder policy.
- [x] 1.4 Restate the module header: ceilings arrive as configuration, and nothing in this module reads the environment. Drop the stale "ported from orchestrator" line while there.

## 2. Spec

- [x] 2.1 Remove the "Resource ceilings loaded from the environment" requirement, recording why it went and what replaces it.
- [x] 2.2 Add "Resource ceilings are supplied by the embedder", covering the config surface, the validation `parseResourcePolicy` still performs, and that no harness path consults `SANDBOX_MAX_*`.
- [ ] 2.3 On archive, update the capability's Purpose paragraph, which still says ceilings are "configured once from the environment".

## 3. Verification

- [x] 3.1 `bun run typecheck` and `bun run lint` clean.
- [x] 3.2 `bun test src/config src/sandbox` green.
- [x] 3.3 Patch bump to 0.19.1. The function was deep-importable, so the removal is breaking in principle; it ships as a patch because nothing imports it — not this repo, not managed Cortex, and the CLI takes only types from the module.
