# Add an `auth` provider error kind

## Why

An expired provider OAuth credential (issue #139, seen on a customer machine) reaches the harness as a bare 401 and falls into the generic non-retryable `provider` branch of `classifyProviderError`, whose framing — "the request is wrong" — is false for this case: the request was well-formed and the *credential* behind it is dead. Nothing downstream can tell the user the one thing that would help ("re-authenticate"), so runs and chat turns die with an unactionable step failure.

## What Changes

- Add `auth` to `ProviderErrorKind` and to the `ProviderError` discriminated union: `{ type: "auth"; retryable: false; message; cause? }`.
- `classifyProviderError` SHALL classify a 401 (on the error itself or anywhere on its cause chain, which is how the AI SDK delivers it) as `auth`, non-retryable — checked before the generic 4xx catch-all.
- `toProviderError` SHALL produce an `auth` message that names the credential as the broken thing (expired / revoked / absent), never the request.
- `isProviderError` accepts the new variant.
- Not breaking: no consumer switches exhaustively on `ProviderErrorKind` today (verified across `harness/src` and the CLI embedder); adding a variant widens the union without invalidating any existing branch.

Near-final implementation exists in `stash@{0}` (`providers/errors.ts` + `errors.test.ts` hunks only — the `post-step-pipeline.ts` hunk in the same stash is unrelated #140 work and must not land with this change).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-providers`: the "Provider failures are returned as a classified ProviderError value" requirement's union gains `{ type: "auth" }`; a provider 401 SHALL classify as `auth`/non-retryable instead of the generic non-retryable `provider` 4xx branch.
- `ai-sdk-provider-runtime`: the "Provider failures remain classified values" requirement's category list gains `auth`.

## Impact

- Code: `harness/src/providers/errors.ts` (union, guard, classifier, wrapper), `harness/src/providers/errors.test.ts`.
- Consumers: embedders can now branch on `type: "auth"` to surface a re-authentication remedy (the CLI's `surface-provider-auth-failures` change consumes this); existing consumers see no behavior change other than 401s carrying `type: "auth"` instead of `type: "provider"` — retryability is unchanged (`false` either way).
- Caveat carried into design: the port-8317 CLIProxyAPI image is a fork whose source is not public, so "expired token ⇒ HTTP 401" is strongly indicated (the AI SDK marked the field failure non-retryable ⇒ 4xx) but not source-verified; classification keys on status alone, never on vendor message text.
