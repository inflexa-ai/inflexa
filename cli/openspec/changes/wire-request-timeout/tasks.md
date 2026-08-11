# Tasks: Wire Request Timeout

## 1. Config schema

- [x] 1.1 Add the optional `requestTimeoutMs` and `maxRetries` fields to both arms of `modelConnectionSchema` in `src/lib/config.ts`. Accept a positive integer for each.
- [x] 1.2 Schema tests: a valid value parses, an absent value parses, and a zero, negative, or non-integer value fails closed.

## 2. Transport and provider wiring

- [x] 2.1 In `src/modules/harness/runtime.ts`, build a wrapper fetch when the connection sets `requestTimeoutMs`. The wrapper forwards to the Bun fetch with `timeout: false` in the init. Justify the cast: bun-types 1.3.x does not declare the `timeout` key, but the runtime honors it.
- [x] 2.2 Compose the wrapper: with a credential source, pass it as the `underlying` of `buildAuthInjectingFetch`. Without one, pass it as `config.fetch` directly. Without the field, install nothing.
- [x] 2.3 Thread `requestTimeoutMs` and `maxRetries` from the connection into all three arms of `providerConfigFor`.
- [x] 2.4 Tests: the provider config carries the two values, an absent field installs no wrapper, and the auth path still refreshes exactly once on a 401.

## 3. Close out

- [x] 3.1 Run `bun run format:file` on the changed source files.
- [x] 3.2 Run `bun run typecheck`, `bun run lint`, and `bun run test` in `cli/`.
