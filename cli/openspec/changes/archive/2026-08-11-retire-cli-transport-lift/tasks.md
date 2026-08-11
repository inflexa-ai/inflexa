# Tasks: Retire CLI Transport Lift

## 1. Remove the lift

- [x] 1.1 Delete `buildTimeoutLiftingFetch` and `buildProviderFetch` from `src/modules/harness/runtime.ts`. Restore the auth-only `fetch` wiring in `bootHarnessRuntimeOnce`.
- [x] 1.2 Update the comment block above the provider wiring: the harness owns the transport lift, and the CLI supplies the values and the credential fetch.
- [x] 1.3 Remove the lift tests from `src/modules/harness/runtime.test.ts`. Keep the 401-refresh tests.

## 2. Close out

- [x] 2.1 Run `bun run format:file` on the changed source files.
- [x] 2.2 Run `bun run typecheck`, `bun run lint`, and `bun run test` in `cli/`.
