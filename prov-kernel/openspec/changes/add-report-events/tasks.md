# Tasks

## 1. The value types

- [x] 1.1 Add the session and report ref types to `src/types.ts`. The session
  ref carries `threadId`, `kind`, and the optional `parentThreadId`. The block
  ref carries `blockKind`. The title ref, the derivation ref with its sources,
  the preview ref, and the version ref complete the set.
- [x] 1.2 Export the new types from `src/index.ts`.

## 2. The union and the switch

- [x] 2.1 Add the nine members to `ProvEvent` in `src/events.ts`, each with
  `analysisId`, `actor`, `model`, and its ref payload.
- [x] 2.2 Add one arm for each member to `applyProvEvent`, over the new
  builders of the document model.

## 3. The builders

- [x] 3.1 Add the report builders to `src/document.ts`, beside
  `appendCreation`. Port the cli mapping one-for-one: the action preamble,
  the report entity, the version entity, and the attribute names.
- [x] 3.2 Record the model agent from the report preamble through the split
  model-agent builders, with the kernel-derived delegation identifier and an
  anonymous association.
- [x] 3.3 Guard the generation edge, the attribution, and the specialization
  of the report entity and of the version entity on the first declaration.
- [x] 3.4 Stamp `inflexa:blockKind` on the four block arms.

## 4. The contract

- [x] 4.1 State the report vocabulary in `SPEC.md`: the two QName formats,
  the nine activity types, and the attribute names.
- [x] 4.2 Extend the golden fixture document with the nine members, and
  regenerate the committed bytes on purpose.
- [x] 4.3 Add the scenario tests: the double-emit guard, the version
  specialization under a re-emission, the lazy report mint, the conversation
  arm with no entity, and the block kind stamp.

## 5. The read model

- [x] 5.1 Type a report entity as `report` and a version entity as
  `report_version` in the lineage read model, with their node shapes.
- [x] 5.2 Cover the two kinds, and make sure that `findFileEntity` returns
  neither.

## 6. The release

- [x] 6.1 Run `bun run typecheck`, `bun run lint`, `bun test`, and
  `bun run build && bun run smoke`.
- [x] 6.2 Set the package version to `0.6.0`.
