# Design: Wire Request Timeout

## Context

The release CLI is a Bun single-file executable, and its `fetch` is the Bun client. An empirical probe against Bun 1.3.14 pinned the transport behavior:

- A response with late headers dies at 300 seconds with a `TimeoutError` (code 23).
- A response with early headers and a then-silent body dies at 300 seconds too. Thus the cut is an idle timeout, not a headers timeout.
- `signal: AbortSignal.timeout(400000)` does not extend the cut. The request still dies at 300 seconds.
- `timeout: 400000` does not extend the cut either.
- `timeout: false` removes the cut. The probe request completed after 330 seconds.
- A `node:http` request also completes after 330 seconds.

The harness change `add-request-timeout` gives the provider capability: `AiSdkProviderConfig.requestTimeoutMs`, a per-attempt response-start guard, and the advertised limit. This change supplies the two embedder values: the config field and the transport realization.

## Goals / Non-Goals

**Goals:**

- One config key in the file of the user raises the ceiling for a slow local model.
- The exact bound stays in one place: the harness guard.

**Non-Goals:**

- No config for the backoff delays of the envelope.
- No setup-flow prompt for the fields. The config file is the surface.
- No change to the credential-refresh behavior of `buildAuthInjectingFetch`.

## Decisions

### 1. The two fields live on both arms of the connection

`requestTimeoutMs` and `maxRetries` join both arms of `modelConnectionSchema` (`src/lib/config.ts:147-160`) as optional positive integers. One connection-level surface serves the two modes, so no arm is a special case. In `cliproxy` mode the managed proxy is a middle hop with its own upstream behavior, and the config lifts the CLI-side transport only.

### 2. The transport realization is `timeout: false`, and the harness guard owns the bound

When the connection sets `requestTimeoutMs`, the composition root builds a wrapper fetch that forwards to the Bun fetch with `timeout: false` in the init. That removes the 300-second idle cut. The exact ceiling then comes from the harness guard, which aborts at `requestTimeoutMs`. Thus the CLI arms no timer of its own, and the bound has one owner.

The `timeout` key is a Bun extension of the fetch init. The `BunFetchRequestInit` type of bun-types 1.3.x does not declare it, but the runtime honors it — the probe above is the evidence. The implementation carries a cast with a comment that records this.

Alternatives. A numeric `timeout` and a longer abort signal: the probe shows no effect. A fetch shim over `node:http`: it works, but it re-implements streams, redirects, and header semantics for no gain. Rejected.

### 3. Composition order: the timeout wrapper is the `underlying` of the auth fetch

`buildAuthInjectingFetch(source, underlying)` (`src/modules/harness/runtime.ts:550`) already takes an injectable `underlying`. With a credential source, the wrapper becomes that `underlying`, so every auth attempt rides the raised transport. Without a credential source, the wrapper itself becomes `config.fetch`. Without the field, nothing is installed and `config.fetch` stays as today (`runtime.ts:831`).

### 4. `providerConfigFor` threads the value

All three arms of `providerConfigFor` (`runtime.ts:832-852`) gain `requestTimeoutMs` and `maxRetries` from the connection. The harness then enforces the guard, bounds the envelope, and advertises the limit to the router and the planner.

## Risks / Trade-offs

- [`timeout: false` removes every idle bound at the transport] → The harness guard restores an idle bound at exactly `requestTimeoutMs`, so a hang cannot outlive one window.
- [A future Bun release changes the untyped `timeout` extension] → The cast site carries the probe rationale. A regression surfaces as the old 300-second cut, not as data loss.

## Migration Plan

No data changes. An absent field keeps the current behavior.

## Open Questions

None.
