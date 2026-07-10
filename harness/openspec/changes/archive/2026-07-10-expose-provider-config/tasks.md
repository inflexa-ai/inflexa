## 1. Barrel exports

- [x] 1.1 Export `AiSdkProviderConfig` (type) and `createConfiguredAiSdkProvider` from
      `src/index.ts`, in the providers section beside `createAnthropicProvider`
- [x] 1.2 Verify no export-name collisions and that the type-only export uses `export type`
      (matching the barrel's existing convention)

## 2. Contract documentation

- [x] 2.1 Extend the JSDoc on `AiSdkProviderConfig` and `createConfiguredAiSdkProvider`
      (`src/providers/ai-sdk.ts`) with the construction contract: the wire model is bound at
      construction (`ChatRequest` has no model field); N seat models over one connection = N
      provider instances differing only in `model`
- [x] 2.2 Note on `createAnthropicProvider` (`src/providers/anthropic.ts`) that it is a
      convenience over the `anthropic` kind of the now-public union

## 3. Tests + verification

- [x] 3.1 Add a barrel-surface test asserting both symbols are importable from the package root
      and that the factory returns a working `ChatProvider` for each kind (reuse the existing
      ai-sdk provider test fixtures/mocked fetch)
- [x] 3.2 Add the two-instances-one-connection test: same endpoint/key config, two models → two
      providers, each request carrying its own bound model (assert via the mocked transport)
- [x] 3.3 `bun run typecheck`, `bun run lint`, `bun test` green in `harness/`; `bun run build`
      so the cli's `file:../harness` consumer sees the new dist surface
