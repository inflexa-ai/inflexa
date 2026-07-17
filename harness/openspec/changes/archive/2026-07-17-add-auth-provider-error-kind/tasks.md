# Tasks — add-auth-provider-error-kind

## 1. Recover the stashed implementation

- [x] 1.1 Extract ONLY the `harness/src/providers/errors.ts` and `harness/src/providers/errors.test.ts` hunks from `stash@{0}` (e.g. `git checkout 'stash@{0}' -- harness/src/providers/errors.ts harness/src/providers/errors.test.ts`) — leave the stash itself intact (long-lived; never pop) and do NOT bring the unrelated `post-step-pipeline.ts` #140 hunk

## 2. Taxonomy implementation

- [x] 2.1 Verify the recovered `errors.ts` matches the spec deltas: `auth` in `ProviderErrorKind` and the `ProviderError` union with literal `retryable: false`; `classifyProviderError` returns `{ kind: "auth", retryable: false }` on `status === 401` before the generic 4xx catch-all; `toProviderError` emits a message naming the credential (expired/revoked/absent), never the request; `isProviderError` accepts the variant
- [x] 2.2 Verify the recovered tests cover: bare 401, 401 nested on the `cause` chain (the AI SDK wrapper shape), `toProviderError` idempotency + credential-naming message; add any of these that the stash version lacks
- [x] 2.3 Confirm no consumer switches exhaustively on `ProviderErrorKind` (grep `harness/src` for narrowing on the kind) so the widening is additive as the proposal claims

## 3. Verify

- [x] 3.1 Run the provider error suite (`bun test src/providers/errors.test.ts`) and the harness typecheck; all green
- [x] 3.2 Run the full harness test suite to catch any consumer that pattern-matched on 401s landing as `type: "provider"`
