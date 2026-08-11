# Design: Retire CLI Transport Lift

## Context

`buildTimeoutLiftingFetch` (`src/modules/harness/runtime.ts:579`) adds `timeout: false` to each provider fetch call. `buildProviderFetch` (`runtime.ts:597`) composes it under the auth-injecting fetch. The harness guard now adds the same key itself when `requestTimeoutMs` is set. Two lifts stack with no effect, and the CLI copy carries a duplicated probe rationale.

## Goals / Non-Goals

**Goals:**

- One owner for the transport lift: the harness guard.
- The CLI keeps only what an embedder must supply: the config values and the credential fetch.

**Non-Goals:**

- No change to the config schema, the resolver, or `pickRequestBounds`.
- No change to the credential-refresh behavior.

## Decisions

### 1. The provider fetch returns to auth-only

`providerConfigFor` receives `buildAuthInjectingFetch(credentialSource)` when a credential source exists, and `undefined` otherwise — the shape before the lift. The two lift builders and their tests go away. The conditional-bounds spread stays untouched.

Alternative: keep the CLI lift as a belt-and-suspenders copy. Rejected, because two owners for one transport decision drift, and the harness tests already pin the behavior.

## Risks / Trade-offs

- [A CLI build runs against a harness pin without the new guard] → The old 300-second cut returns for values above it. The proposal names the pin requirement.

## Migration Plan

No data changes. The user-facing config keeps its meaning.

## Open Questions

None.
