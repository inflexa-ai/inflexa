# harness-session-model Delta

## ADDED Requirements

### Requirement: RunAuthorizer supports out-of-band revocation by persisted jti

`RunAuthorizer` SHALL expose `revokeByJti(ref: { jti: string; auth: AuthContext }, reason: string): Promise<void>` for paths that hold no `RunAuthorization` — external cancellation, where the mandate JWT was never persisted and only its jti survives on `cortex_runs`. The `ref` SHALL carry the caller's opaque `AuthContext` (the sole carrier of credential/org behind a session); the harness never inspects it. The local/OSS realization SHALL no-op — it mints no jti. Normal terminal paths continue to use `revoke(authorization, reason)` under the run credential.

#### Scenario: Local authorizer no-ops

- **WHEN** `createLocalRunAuthorizer().revokeByJti({ jti, auth }, reason)` is called
- **THEN** it resolves without side effects

#### Scenario: Out-of-band cancel revokes by jti

- **WHEN** the run canceler converges a run whose row carries a `mandate_jti`
- **THEN** it calls `revokeByJti` with that jti and the cancelling session's `auth`, never reconstructing a `RunAuthorization`
