## Why

The launch gate forces a full provider OAuth re-login on probe verdicts that do not actually mean the credential is dead, and users hit this several times a day ("I have to log in non-stop"). Investigation against the running proxy and the CLIProxyAPI source established that an empty `/v1/models` list — which `classifyModelResolution` reads as a definitive credential rejection — legitimately occurs with a perfectly healthy credential file: (a) the proxy's HTTP listener accepts requests before its async auth-file registration completes, so a probe racing a cold boot (including the bounce the gate itself performs after a re-login) reads an empty list; (b) a single upstream 401 on the sole credential suspends its models out of the list for 30 minutes (12 hours for 404-class errors) while the on-disk credential stays valid. The spec premise "an empty list means the proxy loaded no credential at all" (`cliproxy-credential-health`) was verified against a warm, unsuspended proxy only and does not hold in general. On top of the misread, the re-login path offers no decline: the first `unauthorized` verdict announces "expired or revoked" and takes the terminal into OAuth.

## What Changes

- An empty model list from an answering proxy is no longer an immediate credential rejection. The probe waits within a bounded budget for the proxy's auth registration to land (a non-empty `/v1/models`) before reading any verdict — covering both the cold `compose up` start and the post-re-login restart, whose re-probe currently races the very boot window its own bounce created.
- A list still empty at the deadline is classified as ambiguous, not dead: launch surfaces an actionable notice naming both remaining causes (credential the proxy cannot load; temporary provider-side suspension) and the re-login remedy, and proceeds — it does not force OAuth on its own.
- Only a definite HTTP 401 remains a credential-rejection verdict, and the inline re-login it drives becomes a confirmable prompt (decline proceeds to launch, where chat surfaces any real auth failure) instead of an unconditional OAuth flow.
- A served 503 whose body carries the proxy's `auth_unavailable`/cooldown error is classified distinctly: launch reports that the credential is cooling down after upstream errors and will recover on its own, instead of the generic "could not verify" warning or any login prompt.
- A 401 from `/v1/models` stops counting as a provider-credential rejection: the proxy's source shows that route is gated by the client-API-key middleware alone, so the verdict names the real condition (client key on disk does not match the running proxy) with `inflexa setup` as the remedy — a re-login cannot fix it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cliproxy-credential-health`: the empty-model-list rejection verdict is replaced by a bounded registration wait plus ambiguous-outcome reporting; the launch-gate re-login becomes confirmable; the probe's classification gains a distinct cooldown outcome; the boot-race wait requirement extends from "port not yet bound" to "answering but auth not yet registered".

## Impact

- `cli/src/modules/infra/setup.ts` — `classifyModelResolution`, `ensureLiveCredential`, `verifyCredentialAtLaunch`, `probeOnce`, `retryWhileUnreachable` (or a sibling readiness wait), and their unit tests.
- `cli/src/modules/proxy/models.ts` — `listModelCandidates` consumers only; no election semantics change (`default-model-election` is untouched: an empty list still yields no election, only its launch-gate interpretation changes).
- No new dependencies; no config surface changes; `direct` connection mode remains unprobed.
