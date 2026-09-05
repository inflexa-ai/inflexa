# Bind the knowledge plane at the composition root

## Why

The harness declares a `KnowledgeClient` seam for the knowledge plane, the remote service that grounds a plan in cited rules and tested script templates. The open-source CLI has no access to the service by default. A license, which is the API key, enables it. The CLI is the embedder, thus it gives the values at its composition root: the endpoint from the config and the key from the environment.

## What Changes

- A top-level `knowledge` config block with one field, `baseUrl`. Per-field resilience, as the embedding block: a malformed field degrades to unset alone.
- The key comes from `INFLEXA_KNOWLEDGE_API_KEY` in the environment only. It is never persisted, never logged, and never sent to provenance.
- `resolveKnowledgeConfig()` resolves the block to `configured`, `missing_key`, or `null`. The boot names the variable once on `missing_key` and runs without the service.
- The boot builds one HTTP client and binds it to the run-engine composition (the step agents), to the conversation assembly (the planner), and to `hostTools` as `knowledge_recommend` for the conversation agent.
- The `--help` env list names the variable.

No command changes. No agent policy changes.

## Capabilities

### New Capabilities

- `knowledge-plane-connection`: the config block, the secret channel, the resolution, and the binding.

## Impact

- `src/lib/config.ts`: the block on the config schema.
- `src/lib/env.ts`: the variable name, the reader, and the help entry.
- `src/modules/harness/config.ts`: `resolveKnowledgeConfig`.
- `src/modules/harness/runtime.ts`, `src/modules/harness/run_deps.ts`: the client on the composition and the deps bags.
- `src/cli/index.ts`: the help list.

A user without the block sees no change. The harness pin must carry the seam before this change is released.
