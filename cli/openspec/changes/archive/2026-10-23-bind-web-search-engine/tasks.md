# Tasks

## 1. The engine hand-off

- [x] 1.1 Build `createSearxngEngine({ baseUrl: env.searxngBaseUrl })` in `bootHarnessRuntime` and inject it as `webSearch` in the conversation deps bag, and update the wiring test to assert the injected engine. Verify `bun test src/modules/harness/runtime.test.ts`, `bun run typecheck`, and `bun run format:file` on the changed files pass
