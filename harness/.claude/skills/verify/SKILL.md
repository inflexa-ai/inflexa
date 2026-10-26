---
name: verify
description: Verify harness changes at the package boundary — build dist, link the package into a scratch consumer, drive a chat turn, tools, and gateways against a real Postgres via podman. Use after changing @inflexa-ai/harness when the CLI does not yet consume the change.
---

# Verifying @inflexa-ai/harness at the package boundary

The harness is a library: its surface is the npm package export, not a CLI or
server. The embedding CLI consumes the *published* harness, so an uncommitted
harness change is only observable by importing the freshly built package.

## Recipe that works

1. Build: `cd harness && npm run build` (tsc → `dist/`), then `bun link`.
2. Postgres (this machine uses **podman**, not Docker Desktop):
   ```bash
   podman run -d --name verify-pg -e POSTGRES_USER=cortex -e POSTGRES_PASSWORD=dev \
     -e POSTGRES_DB=cortex -p 127.0.0.1:5599:5432 pgvector/pgvector:pg18
   podman exec verify-pg pg_isready -U cortex   # poll until ready (~3s)
   ```
3. Scratch consumer in the session scratchpad: `package.json` with
   `"type": "module"` and deps `neverthrow` + `zod` (match harness majors), then
   `bun link @inflexa-ai/harness && bun install`. Run scripts with **node**
   (harness runtime is Node; bun is test-only).
4. Import ONLY from `@inflexa-ai/harness` (the barrel). Useful exports:
   `createPool`, `initCortexState(pool)`, `assembleCoreRuntime`, `runChatTurn`,
   `defineTool`, `makeLocalAuth`, plus whatever seam is under test. The test
   model is `scriptedModel` from `@inflexa-ai/harness/testing`.

## Gotchas

- `createPool` takes `port` as a **string** and requires `sslMode: "disable"`
  for a local container — default config path expects SSL.
- `scriptedModel` takes one script entry for each model request. A request
  past the end of the script fails, thus a script that is too short shows as a
  failed turn, not as a hang.
- Session shape: `{identity:{user}, scope:{kind:"analysis", analysisId,
  threadId}, provenance:{agentId, callPath:[agentId]}, auth: makeLocalAuth()}`.
- Spawned helper processes exit fast — guard `child.exitCode !== null` before
  awaiting its `exit` event, or the await never settles (Node exit code 13).
- `TRUNCATE cortex_*` tables between runs for idempotent assertions.
- Cross-process claims (polling gateways, ledgers) deserve a real second
  process: spawn a sibling node script with its own pool.
