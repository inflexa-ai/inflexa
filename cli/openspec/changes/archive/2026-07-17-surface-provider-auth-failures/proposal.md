# Surface provider auth failures actionably

## Why

A dead provider OAuth credential behind the local CLIProxyAPI container (issue #139) is undetectable before work starts and unactionable when it strikes: `isAuthenticated()` only checks that *some* non-dot entry exists in the auth dir (a `logs/` subdirectory or a `disabled: true` credential passes), `inflexa setup` then answers "Already authenticated" — actively misleading after a refresh death — and a mid-chat/mid-run 401 surfaces as a generic step failure. The user gets the illusion of "ready to work", starts something, watches it fail, and has to exit the TUI to re-login. A dead refresh token is statically invisible (the vendor never persists refresh failures to the credential file — `disabled` is operator-set only), so the only honest detection is a live request; the cheapest place that prevents the trap is TUI launch.

## What Changes

- **Launch-time credential probe** in `ensureProxyReady`, in `cliproxy` mode ONLY (a `direct` connection authenticates with the user's own env key and is never probed): after the compose stack is up, send one minimal model request through the proxy. A definite credential rejection — a 401, or an empty model list from an answering proxy, which means it loaded no credential at all — drives the existing interactive provider login inline at launch (TTY) or fails with an error naming the forced re-login command (non-TTY). Any other served failure (5xx) warns and proceeds, and a proxy that is not answering yet is retried within a bounded budget before its silence is called unreadable — a started container is not a bound port, and the probe must not become a new way for launch to block. The per-launch provider-request cost is accepted deliberately: paying ~1 token at launch beats discovering a dead credential mid-work.
- **Harden `isAuthenticated`**: consider only `*.json` entries, treat `disabled: true` as unauthenticated, and never gate on the `expired` timestamp (the access token expires every 8h by design and the proxy refreshes it).
- **Truthful setup messaging**: the "Already authenticated" branch stops asserting validity (setup cannot statically know it) and names the forced re-login path instead.
- **Chat-surface auth mapping**: a failed turn whose cause chain carries the harness `ProviderError` `type: "auth"` renders a dedicated banner naming the configured provider and the remedy, instead of the generic wrapped detail.

## Capabilities

### New Capabilities

- `cliproxy-credential-health`: what counts as a present provider credential (structural check semantics), the launch-time live probe and its failure policy, and setup's truthful reporting of credential state.

### Modified Capabilities

- `chat-view`: the turn-failure error surface gains an auth-specific requirement — a `type: "auth"` provider error renders the re-authentication remedy naming the configured provider.

## Impact

- Code: `src/modules/infra/setup.ts` (`isAuthenticated`, `ensureProxyReady`, setup messaging), reusing `src/modules/proxy/models.ts` (`readApiKey`, `resolveModelId`) for the probe; `src/tui/hooks/conversation.ts` + `src/lib/cause.ts` for the chat mapping.
- Dependency: consumes the harness `auth` error kind (harness change `add-auth-provider-error-kind`) via the `file:../harness` dependency.
- Out of scope: an in-TUI re-auth dialog with automatic turn retry (candidate follow-up); pausing/resuming runs interrupted by auth failures (same shape as the deferred budget-pause resume); deleting the caller-less Auth0 refresh machinery in `modules/auth/auth.ts` (separate cleanup).
