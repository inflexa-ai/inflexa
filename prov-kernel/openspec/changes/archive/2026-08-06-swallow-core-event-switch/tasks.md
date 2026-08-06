## 1. Move the switch

- [x] 1.1 Add `src/events.ts`: the nine-variant `ProvEvent` union, built on
  the kernel's own ref/actor types, moved from the Cortex host copy.
- [x] 1.2 Add `applyProvEvent(model, doc, event)` in the same file: the
  exhaustive switch onto the model's builders, with a `never` default that
  throws. Keep the mapping semantics exactly — builder choice and order per
  event, deterministic relation ids, dedupe under `unified()`.
- [x] 1.3 Export `ProvEvent` and `applyProvEvent` from `src/index.ts`. Keep
  the builders and `appendLifecycleAction` exported, and say in one line that
  they are the extension mechanism.

## 2. Tests

- [x] 2.1 Add `src/events.test.ts`: drive the ported event sequences through
  `applyProvEvent` against `createProvDocumentModel()` — one run's
  statements, re-emission dedupe with no blank-node execution relations,
  command/file/input statement shapes, run/step lifecycle statements, the
  analysis lifecycle events, and the throw on an out-of-union event. Fixed
  timestamps only.
- [x] 2.2 Keep the golden fixture test unchanged and green.

## 3. Documents

- [x] 3.1 Add the `SPEC.md` "Events" section: per core event, the statements
  it appends with their id schemes, derived from the code.
- [x] 3.2 Update the boundary prose in `README.md`, `CLAUDE.md`, and the
  barrel doc comment.

## 4. Version and verify

- [x] 4.1 Bump `package.json` from 0.2.0 to 0.3.0.
- [x] 4.2 `bun install` (lockfile in sync), `bun run typecheck`,
  `bun run lint`, `bun test`, `bun run build && node scripts/smoke.mjs`,
  `openspec validate --all --strict`.
- [x] 4.3 `bun run format:file` on every touched file under `src/`.
