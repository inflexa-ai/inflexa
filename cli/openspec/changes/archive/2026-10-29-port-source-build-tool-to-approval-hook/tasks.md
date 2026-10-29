# Tasks

## 1. The approval hook of the tool

- [x] 1.1 Add the pure decision function with the request key of each ask. Make sure that unit tests of each phase pass.
- [x] 1.2 Add the `approval` hook with the grant keys of design.md. Make sure that tests of the request text and the grant keys pass.
- [x] 1.3 Record the decision of each call on the session entry. Make sure that a test reads the record under the `invocationId`.
- [x] 1.4 Let `execute` decide again inside the queue, and return `approval_stale` on a mismatch. Make sure that the stale-approval test passes.
- [x] 1.5 Remove `ctx.ask` and the rejection path, and state the denial rule in the description. Make sure that `bun run typecheck` passes.

## 2. The tests of the tool

- [x] 2.1 Port the test driver to the `runCall` pattern of `inflexa_tool.test.ts`. Make sure that each kept test passes.
- [x] 2.2 Replace each test that a rejection stops the session. Make sure that a denied call runs nothing and keeps the session.
- [x] 2.3 Replace the test of a call that waits for an earlier ask. Make sure that the stale-approval and grant-key tests pass.

## 3. Stale comments and checks

- [x] 3.1 Correct the comments that name `ctx.ask` in the CLI. Make sure that a search finds no `ctx.ask` in `cli/src`.
- [x] 3.2 Format the changed source files. Make sure that the lint, the typecheck, and the full test suite pass in `cli/`.
