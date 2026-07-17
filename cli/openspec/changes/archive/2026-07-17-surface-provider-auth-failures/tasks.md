# Tasks — surface-provider-auth-failures

## 1. Prerequisite

- [x] 1.1 Ensure the consumed `@inflexa-ai/harness` carries the `auth` `ProviderError` kind (harness change `add-auth-provider-error-kind`); re-run `bun install` in `cli/` so the `file:../harness` link picks it up

## 2. Credential presence check + setup messaging

- [x] 2.1 Harden `isAuthenticated` (`src/modules/infra/setup.ts:659`): consider only `*.json` entries; parse each and treat `disabled: true` as not authenticated; treat unreadable/unparseable JSON as present; never read `expired`
- [x] 2.2 Unit-test the check against tmp dirs: logs/-only dir, disabled credential, healthy credential with past `expired`, corrupt JSON
- [x] 2.3 Reword the already-authenticated branch (`setup.ts:135`) per the truthful-reporting requirement: a credential exists; `--provider <name>` re-login is the fix for failing authentication; no validity claim

## 3. Launch-time credential probe

- [x] 3.1 Verify against the running fork that `GET /models` answers without exercising the provider credential (design open question); if it 401s on a dead credential, use that as the probe signal instead of a completion request
- [x] 3.2 Implement the probe in `ensureProxyReady` after `composeUp`, cliproxy mode only: `readApiKey` → `resolveModelId` → minimal completion (`max_tokens: 1`, ~10s timeout) via `env.cliproxyApiUrl`; `Result`-channel wrapper for the fetch per the neverthrow boundary rule
- [x] 3.3 Wire the rejection policy: TTY → inline `authenticate()`, restart the proxy service, re-probe once, second rejection fails naming both causes (re-login didn't take / client-key mismatch); non-TTY → `ProxyError` naming `inflexa setup --provider <kind>`
- [x] 3.4 Wire the non-rejection policy: warn (including the observed status/failure) and proceed — no new blocking failure modes; record the status the fork actually emits for a dead credential in the change notes (feeds the harness classifier caveat)
- [x] 3.5 Unit-test the probe policy matrix through the injected seams: healthy, rejection+TTY (re-login path invoked), rejection+non-TTY, unobservable, failed relogin, failed restart, second rejection
- [x] 3.6 Classify an answering proxy's empty model list as a rejection, not an outage — it is the one signal that catches a credential the presence check let through but the proxy cannot load; unit-test `classifyModelResolution` over every `ChatSetupError`
- [x] 3.7 Retry a probe that gets no answer within a bounded budget (a started container is not a bound port; the re-probe's own restart guarantees a cold one), bound every probe round-trip so the budget bounds the loop, and degrade to warn-and-proceed at the deadline; unit-test `retryWhileUnreachable`

## 4. Chat-surface auth mapping

- [x] 4.1 Add a structural auth-kind finder beside `describeCause` in `src/lib/cause.ts` (walks the cause chain, bounded depth, matches `{ type: "auth" }` provider-error shape)
- [x] 4.2 In `src/tui/hooks/conversation.ts` turn-failure handling, branch on the finder: render the provider-naming remedy message from the RESOLVED connection (which always carries a slug — no slug-less branch), naming `INFLEXA_MODEL_API_KEY` in `direct` mode and dropping only the re-login hint when the slug maps to no login flow
- [x] 4.3 Extend `conversation.test.ts` + `cause.test.ts`: auth cause at depth → remedy banner; direct mode → env-key remedy; unrecognized slug → no re-login hint; auth cause below the depth bound → generic fallback; non-auth causes unchanged

## 5. Verify

- [x] 5.1 `bun run format:file` on every touched `src/` file; `bun run typecheck`; `bun run lint`; full `bun test`
- [x] 5.2 Live pass with the local stack: healthy launch (no prompt, no extra output), and a dead-credential simulation (e.g. a scratch auth dir with no/disabled credential against a scratch proxy — never mutate the real credential) driving the inline re-login
