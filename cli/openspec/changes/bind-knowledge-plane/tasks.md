## 1. The config and the secret

- [x] 1.1 Add the optional `knowledge` block with `baseUrl` to the config schema, with per-field resilience.
- [x] 1.2 Add `KNOWLEDGE_API_KEY_VAR`, `resolveKnowledgeApiKey`, and the help entry to `lib/env.ts`.
- [x] 1.3 Add `resolveKnowledgeConfig` to `modules/harness/config.ts` with the three outcomes.
- [x] 1.4 Test the four scenarios in `modules/harness/config.test.ts`.

## 2. The binding

- [x] 2.1 Build the client at boot and warn once on a missing key.
- [x] 2.2 Bind the client to `RunEngineComposition` and to the step agent deps.
- [x] 2.3 Bind the client to the conversation assembly for the planner.
- [x] 2.4 Add `knowledge_recommend` to `hostTools` when the client is bound.
- [x] 2.5 List the variable in `--help`.
