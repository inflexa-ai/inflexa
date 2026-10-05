# Design

## Context

`runFetch` (`src/tools/lib/api-utils.ts:138`) gave the `headers` option to
`fetch` without a change. No caller of `apiFetch` sets a User-Agent. Thus
Node sends `node`, and Bun sends `Bun/<version>`.

AlphaFold DB answers 403 with an HTML body to `node`, `undici`,
`Bun/<version>`, and an empty value. It answers 200 to `curl/8.5.0`,
`Mozilla/5.0`, `inflexa-harness`, and
`inflexa-harness (+https://inflexa.ai)`. The four other EBI hosts of the
harness answer 200 to `node`.

`isUnexpectedApiError` (`api-utils.ts:229`) reads each `http_status` in the
4xx band as expected. `fetchAlphaFoldPrediction` gave `null` for each
expected error. Thus the 403 became `found: false`.

The Crossref client (`src/citations/clients/crossref.ts`) takes its own
`userAgent` option, and it does not use `apiFetch`.

## Goals / Non-Goals

**Goals:**

- Each `apiFetch` request identifies the harness.
- An AlphaFold refusal is an error tool result, not an absence.

**Non-Goals:**

- A change to `isUnexpectedApiError`. Eleven call sites read it, and each
  provider has its own absence codes. A global change needs a review of each
  site.
- A version in the User-Agent. The harness has no version constant, and a
  version gives AlphaFold nothing that it uses.
- A User-Agent for the Crossref client, the literature HTTP layer, or the
  fixture refresh script. They do not use `apiFetch`.

## Decisions

### D1. One static value, set in `runFetch`

`HARNESS_USER_AGENT` is `inflexa-harness (+https://inflexa.ai)`. The URL
gives a provider a contact point. `runFetch` builds one `Headers` object
before the attempt loop (`api-utils.ts:151-152`), and each attempt sends it.

### D2. The header of the caller wins

`runFetch` sets the value only when `Headers.has("user-agent")` is false.
`Headers` compares names without letter case. Thus a caller that sets
`user-agent` does not get two values.

### D3. The AlphaFold client names its absence codes

`fetchAlphaFoldPrediction` gives `null` only for `http_status` 400 or 404
(`alphafold-client.ts:84`). Each other `ApiError` throws, and the agent loop
records an error tool result. These two codes are the documented absence
encoding of AlphaFold DB. A 401, a 403, or a 410 is a refusal or a change of
the contract, and the tool description tells the agent not to retry an
absence.

## Risks / Trade-offs

- A provider can refuse the new value. The same provider then answers 403,
  the same as for the runtime value. For AlphaFold, that now shows as an
  error.
- A provider that answers 403 for a real absence now gives an error at the
  AlphaFold call site only. AlphaFold DB does not do this today.
