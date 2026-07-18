---
name: verify
description: Verify harness changes at the package boundary — build dist, link the package into a scratch consumer, drive runAgent/tools/gateways against a real Postgres via podman. Use after changing @inflexa-ai/harness when the CLI does not yet consume the change.
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
   `createPool`, `initCortexState(pool)`, `runAgent`, `defineTool`,
   `passthroughStep`, `makeLocalAuth`, plus whatever seam is under test.

## Gotchas

- `createPool` takes `port` as a **string** and requires `sslMode: "disable"`
  for a local container — default config path expects SSL.
- A fake `AgentChat` must return neverthrow `okAsync({message, finishReason})`
  and SHOULD honor the `signal` argument (`if (signal?.aborted) throw
  signal.reason`) — the real AI SDK provider does, and abort-path behavior is
  wrong without it (chat wires no `isFatalLoopError`; cancellation exits via
  the provider call).
- Session shape: `{identity:{user}, scope:{kind:"analysis", analysisId,
  threadId}, provenance:{agentId, callPath:[agentId]}, auth: makeLocalAuth()}`.
- Spawned helper processes exit fast — guard `child.exitCode !== null` before
  awaiting its `exit` event, or the await never settles (Node exit code 13).
- `TRUNCATE cortex_*` tables between runs for idempotent assertions.
- Cross-process claims (polling gateways, ledgers) deserve a real second
  process: spawn a sibling node script with its own pool.
