# Design — add-auth-provider-error-kind

## Context

`harness/src/providers/errors.ts` classifies provider failures into `ProviderErrorKind = "budget" | "tenant-blocked" | "provider"`. `extractStatus` (errors.ts:120) already walks the `cause` chain, so a status nested inside an `AI_APICallError` wrapper is reachable. A 401 currently lands in the generic "concrete 4xx ⇒ the request is wrong; retrying it unchanged will fail again" branch (errors.ts:166) — a premise that is false when the credential, not the request, is broken. The field failure (issue #139): the local CLIProxyAPI container's provider OAuth refresh died, every call answered "OAuth access token has expired. Re-authenticate to continue.", and the harness surfaced an unactionable generic step failure.

Near-final code exists in `stash@{0}` (the `providers/errors.ts` + `errors.test.ts` hunks; the `post-step-pipeline.ts` hunk in the same stash is unrelated #140 work).

## Goals / Non-Goals

**Goals:**

- A 401 from any provider path classifies as a distinct, non-retryable `auth` kind whose message names the credential as the broken thing, so any embedder can surface a re-authentication remedy.
- Idempotent wrapping (`toProviderError`) and the `isProviderError` guard cover the new variant.

**Non-Goals:**

- Making the credential refresh work — that lives inside the third-party proxy binary (or a future harness-owned OAuth flow), not this change.
- Any pause/resume behavior for runs interrupted by an auth failure. That has the same shape as the 402 budget pause and belongs with the deferred `resume-analysis-after-budget-pause` work.
- Embedder-side surfacing (the CLI's `surface-provider-auth-failures` change owns detection, launch probing, and chat messaging).

## Decisions

- **`auth` is a fourth kind, not a flag on `provider`.** The remedy is categorically different from every other non-retryable 4xx: no amount of re-issuing or rephrasing the request helps — a human has to re-authenticate. A kind is what consumers can branch on; a message string is not.
- **Classification keys on `status === 401` only — never on vendor message text.** The harness is host-agnostic; the field failure's exact string belongs to one proxy fork whose source is not public. Status is the only signal with a stable contract. Checked before the generic 4xx catch-all so ordering makes the specialization explicit.
- **401 covers both credential flavors behind a proxy** (dead provider OAuth *and* a wrong proxy client key): both are "the credential the host put behind the call is broken", both need human action. Disambiguating the remedy is the embedder's job — it knows which credentials it wired.
- **Non-retryable, hard.** The variant is declared `retryable: false` (literal, not `boolean`): retrying an expired credential can only succeed if a human intervenes mid-run, which is not a retry policy the loop should encode.
- **Additive, not breaking.** No consumer switches exhaustively on `ProviderErrorKind` (verified across `harness/src` and the CLI embedder); widening the union compiles everywhere. 401s previously classified `{ provider, retryable: false }` now classify `{ auth, retryable: false }` — retry behavior is identical, only the label and message change.

## Risks / Trade-offs

- [The proxy fork might not emit HTTP 401 for the expired-token case — its source is not public, so "expired ⇒ 401" is inferred (the AI SDK marked the field failure non-retryable ⇒ some 4xx), not source-verified] → **Resolved during implementation, live**: a scratch container with a fabricated dead credential (past `expired`, bogus `refresh_token`) answers `/v1/messages` with HTTP 401 (`auth_unavailable: no auth available`). The 401 key is the verified right signal (full observations: the CLI change `surface-provider-auth-failures`, design.md "Verification notes").
- [A gateway that (incorrectly) emits 401 for a non-credential fault would now be labeled `auth`] → The message carries the upstream detail verbatim; the mislabel is strictly more actionable than the current "request is wrong" framing for the dominant real-world 401 cause.

## Migration Plan

None needed: additive union member, no schema or storage change, no consumer rewrites. Rollback is deleting the branch.
