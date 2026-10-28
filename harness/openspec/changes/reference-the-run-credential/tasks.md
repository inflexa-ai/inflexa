# Tasks: reference-the-run-credential

## 1. Seam

- [x] 1.1 `RunAuthorizer`: add `suspend` and `renew`; rename `revokeByJti` to `revokeByMandateId`
- [x] 1.2 Local authorizer: no-op the new methods
- [x] 1.3 Hook names: `RunAuthorizer.renew` gate, `RunAuthorizer.suspend` and `revokeByMandateId` notices
- [x] 1.4 Remove `RunAuthorization` and `ownsMandate`: `authorize` gives the `RunSession`, `revoke` takes it, and the terminal path always revokes

## 2. Pause and resume

- [x] 2.1 The pause of a run, a step, a sub-agent of a run, and a profile carries the run session and the authorizer
- [x] 2.2 A `paused` wait suspends in a durable step; a `retrying` wait does not
- [x] 2.3 The pause row keeps the run session (migration `record_the_run_session_of_a_pause`)
- [x] 2.4 `resume` renews one time for the work, and gives `refused` on a refusal

## 3. Run ledger

- [x] 3.1 Migration `reference_the_run_mandate`: `mandate_jti` to `mandate_id`, drop `mandate_expires_at`
- [x] 3.2 `setRunMandate`, the row schema, the queries, and the canceler use the mandate id

## 4. CLI

- [x] 4.1 The resume route answers 403 `forbidden` for `refused`

## 5. Specs and docs

- [x] 5.1 Deltas of the modified capabilities
- [x] 5.2 `CONTEXT.md` names the new seam methods
