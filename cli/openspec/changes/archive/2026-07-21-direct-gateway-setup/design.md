## Context

A live gateway probe on an enterprise machine (Bedrock-backed corporate gateway, `company-code
token` helper minting IdP JWTs) established the target shape this change must survive:

- `POST {baseURL}/messages` with `Authorization: Bearer <jwt>` → 200 (Anthropic format). This is
  the only surface the gateway guarantees.
- `GET {baseURL}/models` → 404 under every prefix, even authenticated.
- `x-api-key` → 500 `invalid token` (rejected at auth middleware, before routing — never 401).
- `count_tokens` → unavailable (Bedrock's Anthropic-format surface does not carry it).
- The helper caches: it served a token with 3925s remaining of a 4225s issued lifetime.

Today's code fails this shape at four points: the setup probe hard-requires `/models` 2xx and
discards the auth block otherwise (`setup.ts` `probeCredentialSource`); direct setup collects no
model id so boot fails `model_required`; raw command tokens age off a blanket 5-minute TTL rather
than their own `exp`, while the reactive refresh path listens only for 401; and
`model_listing.ts` hardcodes the static env key + `x-api-key` for direct-anthropic listing and
validation.

Prior decisions this design must respect: `baseURL` is the single `/v1`-terminated root every
consumer derives from; provider is a configured fact, never derived from a model id (the reverse
direction, provider→default, is what this change uses); listing/validation failures are expected
outcomes that degrade, never block.

## Goals / Non-Goals

**Goals:**

- A direct anthropic-protocol connection against a messages-only bearer gateway is configurable
  end-to-end through interactive `inflexa setup` — no hand-edited `config.json`.
- The setup probe validates what chat will actually do, and never discards a working credential
  because an optional route is missing.
- Helper-minted JWTs are held no longer than their self-described lifetime.
- The picker surfaces authenticate the same way the chat path does when an `auth` block exists.

**Non-Goals:**

- No `inflexa config` (TUI settings screen) section for the model connection — a separate change.
- No decode of `exp` for `kind: "env"` tokens: a fixed process env cannot yield a fresh token, so
  expiry-driven re-reads gain nothing; the 401 force-refresh path remains its only rotation.
- No reactive refresh on non-401 statuses (a gateway 500 stays a surfaced provider error): with
  `exp`-accurate proactive refresh, holding a truly-dead token becomes rare, and retrying on
  arbitrary 5xx would mask real outages.
- No non-TTY direct model collection: scripted direct setup still writes no model and boot's
  `model_required` remains the actionable failure (documented, unchanged).
- Bedrock/Vertex request signing (SigV4 etc.) stays out of scope — the gateway is assumed to
  terminate provider auth.

## Decisions

**D1 — Probe ladder: `/models` is opportunistic, the messages ping is authoritative.**
Order: (1) `GET {baseURL}/models` — 2xx passes and its ids feed the model prompt's pre-fill list;
(2) a 401/403 from any rung fails the probe with the scheme hint; (3) any other `/models` outcome
escalates to a protocol-shaped `max_tokens: 1` POST (`/messages` + `anthropic-version` for
anthropic, `/chat/completions` for openai-compatible); (4) on the ping, 2xx or a definite
model-not-found body passes (the request cleared auth and routing — all a *credential* probe
asserts); anything else is ambiguous → show status + body excerpt, offer save-anyway. Alternatives
rejected: `count_tokens` as the middle rung (predictably 404s on exactly the gateways this path
exists for, and the ping rung is needed regardless); keeping `/models` as a hard gate (the bug).
The ping spends ~10 output tokens once, interactively, with the spinner naming it — distinct from
the recurring, unprompted checks the "not ours to spend" rule targets.

**D2 — Probe with the user's model when available.** The direct flow collects the model id before
the credential probe runs, so one ping validates credential + endpoint + model as the exact triple
chat will use. When the probe must run model-less (auth offered but model prompt declined/skipped),
it pings with the provider-conventional default and treats model-not-found as pass (D1.4).

**D3 — Three-tier model pre-fill; conventional defaults are data, not flow.** Pre-fill precedence:
ranked `/models` listing (when 2xx) → conventional default for the provider slug → empty free
text. The defaults live as a new optional column on `MODEL_FAMILIES` (`proxy/models.ts`) — the
table that already owns the one-directional provider-keyed mapping and carries the direction-ban
comment — not as a second setup-local table. Entries: anthropic, openai, google only; keyed on the
provider slug, deliberately not the protocol (an openai-*compatible* endpoint routinely serves
non-GPT models; a custom slug gets no guess). The column carries a rot-risk comment: ids go stale
on deprecation, which is acceptable *only* because the value is a pre-fill the user confirms and
the ping validates — a stale default costs one failed request and one edit, surfaced at setup with
the endpoint's own error, never a persisted broken config.

**D4 — Model commit path: ping-validate, re-prompt on definite not-found, save-anyway otherwise.**
The confirmed id goes through the same ping; a definite model-not-found re-prompts with the
endpoint's error body shown (gateways often name served ids there); ambiguity offers save-anyway.
Persistence via `writeAgentModel` to BOTH agents — identical semantics to the cliproxy election's
explicit pick.

**D5 — JWT expiry: earliest-wins, parse-tolerant, command-kind only.** In `parseCommandCredential`'s
raw branch, a token starting `eyJ` gets its payload base64url-decoded for a numeric `exp` (seconds).
`expiresAt = min(exp × 1000, now + ttlMs)` when `ttlMs` is set; `exp × 1000` alone otherwise; the
5-minute default only when no `exp` is readable. Earliest-wins because `exp` is a hard fact while
`ttlMs` is a refresh cadence — minting early is harmless, holding past `exp` is the bug (and on
gateways that 500 instead of 401, the reactive net below it never fires). An already-past `exp`
still returns the credential (next `get()` re-mints; a helper serving nearly-dead cached tokens
degrades to per-request minting, never a wedge). Any decode failure degrades to "no self-described
expiry", mirroring the ExecCredential bad-timestamp rule.

**D6 — Picker surfaces resolve the connection's credential like the chat path.** `requestFor` and
`validateModelSelection` in `model_listing.ts` gain a credential-resolution seam: with an `auth`
block, resolve through `createCredentialSource` and send per the configured scheme (bearer deletes
`x-api-key`, sets `Authorization`); without one, the static env key keeps today's per-protocol
headers. All failure modes stay on the existing fail-open paths (`key_missing`→free text,
throw→`inconclusive`).

## Risks / Trade-offs

- [Conventional defaults rot] → pre-fill-only + ping validation before persisting; tiny table with
  a rot-warning comment; stale entry costs one edit at setup, never a broken config.
- [The ping bills a real request to the user's account] → one-time, interactive, spinner names it;
  `max_tokens: 1` bounds the spend to ~10 tokens.
- [Gateway error heterogeneity misclassifies outcomes] (e.g. 500-for-bad-token reads as
  "ambiguous", not "credential rejected") → save-anyway keeps the user in control either way; the
  excerpt shows the gateway's own words; a wrongly-saved block still fails actionably at first chat
  via the existing credential-error surface.
- [A JWT-shaped opaque token with a bogus `exp`] (e.g. an unrelated `exp` claim in a gateway JWT) →
  earliest-wins can only shorten the hold, never extend it past `ttlMs`'s cadence when set; worst
  case is extra mints of a helper that caches anyway.
- [Two credential-source instances (boot's and the picker's) double-mint] → acceptable: the picker
  is user-paced and the helper caches; unifying the instances would couple `model_listing` to boot
  lifetime for no correctness gain.

## Migration Plan

Pure addition on existing config shapes — no schema change, no data migration. Existing direct
connections (static key or auth block) behave identically except: raw JWTs now refresh by `exp`
when sooner than the default TTL, and the setup probe passes on gateways it previously failed.
Rollback is a revert.

## Open Questions

(none — all decisions settled with the user: probe ladder shape, default-table scope
[anthropic/openai/google], picker surfaces in scope, `exp` precedence, non-TTY and env-kind
non-goals, save-anyway semantics.)
