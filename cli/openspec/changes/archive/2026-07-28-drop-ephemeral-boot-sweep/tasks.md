## 1. Adopt the adhoc harness surface

- [x] 1.1 Update the harness dependency to a version exposing `runAdhoc` and removing the ephemeral runner/sweep APIs.
- [x] 1.2 Replace the ephemeral workflow dependency bundle with the local `runAdhoc` bundle in the core runtime assembly.
- [x] 1.3 Rename `harness.resourceLimits.ephemeral` parsing and resolution to `adhoc`, supplying `ResourcePolicy.adhoc`.

## 2. Remove the obsolete recovery exception

- [x] 2.1 Remove the `sweepEphemeralWorkflows` import, `BootSeams` member, real seam binding, and `beforeLaunch` call.
- [x] 2.2 Update boot comments and ordering tests so the remaining ask-expiry, agent-switch, and sandbox-hygiene duties retain their order.
- [x] 2.3 Confirm the sidebar/run readers need no code change for plan-less adhoc ledger rows.

## 3. Verify

- [x] 3.1 Run focused harness runtime/config tests and fix failures.
- [x] 3.2 Run `bun run typecheck` and `bun run lint`.
- [x] 3.3 Run `openspec validate drop-ephemeral-boot-sweep --strict`.
