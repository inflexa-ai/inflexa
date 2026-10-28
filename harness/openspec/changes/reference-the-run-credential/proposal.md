# Proposal: reference-the-run-credential

## Why

The `RunSession` of a run and of a profile goes into the DBOS workflow input. In the managed build, its `auth` held a mandate token with an 8-hour lifetime. Thus a run that took longer than the token, or a run that paused and resumed later, failed at its next call to the host, and a replay read the same expired token again.

The work has no time limit. Its state is in the database and in the files. The pause and the resume of `pause-and-resume-work` make long waits normal. The run session must hold a durable reference to the run credential, and the host must resolve it to a short-lived credential at each call.

## What Changes

- The `RunSession` is a durable reference to the run credential, not a time-bound secret. The harness forwards it as before, and the host resolves it.
- **BREAKING** `RunAuthorizer` gets `suspend(runSession, reason)`, a notice, and `renew(runSession, auth)`, a gate.
- A pause in the state `paused` of a run, a step, a sub-agent of a run, or a profile suspends the run credential. The pause row keeps the run session.
- `PausedWorkSurface.resume` renews the run credential under the session of the resume before it sends a message. A refusal gives `{ kind: "refused", reason }` and keeps the work paused.
- **BREAKING** `RunAuthorization` and its `ownsMandate` go away. `authorize` gives the `RunSession`, and `revoke` takes the `RunSession`. The work that holds a mandate ends it, thus the terminal path always revokes.
- **BREAKING** `revokeByJti` becomes `revokeByMandateId`, and `RevokeByJtiRef` becomes `RevokeByMandateRef`.
- **BREAKING** `cortex_runs.mandate_jti` becomes `mandate_id`, and `mandate_expires_at` goes away. `setRunMandate` takes the mandate id only.
- The CLI resume route answers 403 `forbidden` for a refused renewal.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `harness-session-model` — the run session is a durable reference; `authorize` gives it and the terminal path always revokes it; the authorizer suspends and renews it; the out-of-band revoke takes the mandate id.
- `work-pause` — a pause for a person suspends the run credential, and a resume renews it first.
- `host-hooks` — `RunAuthorizer.authorize` gives a `RunSession`, `RunAuthorizer.renew` is a gate, and `RunAuthorizer.suspend` and `revokeByMandateId` are notices.
- `harness-durable-runtime` — the list of the seam methods.
- `run-state-persistence` — `cortex_runs` keeps `mandate_id` with no expiry.
- `run-cancellation` — the canceler revokes by the mandate id.

## Impact

- Each embedder that realizes `RunAuthorizer` must add `suspend` and `renew`, and rename `revokeByJti`. The local realization no-ops them.
- Each realization of `authorize` gives the `RunSession`, and each realization of `revoke` takes it. A realization that got its mandate from its caller now gets a `revoke` at the end of the work.
- Cortex must keep a mandate id in the `auth` of the run session, not a token, and resolve it to a token at each call to Nexus.
