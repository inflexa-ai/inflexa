# retire-proxy-chat-dev-umbrella — Proposal

## Why

One chat, clean tree (change 3 of `docs/harness_integration_followup/14-tui-chat-direction.md`, the
final change of the binding sequence). The proxy chat engine has been orphaned since change 1 — its
only remaining importer is the boot-helpers line — and the session-scoped bus events it emitted have
zero consumers. Meanwhile the dev/E2E text commands (`chat`, `profile`, `run`) still ship in
production builds where a user has no reason to run them (profiling is automatic, runs launch from
conversation).

## What Changes

- **Delete the proxy chat engine**: `modules/intelligence/chat.ts`'s `chat()`/`toModelMessages` and
  their SQLite `messages`/`parts` write path go; the tables freeze legacy-readable. **BREAKING** for
  nothing — the TUI stopped calling it in change 1; greps confirm zero consumers.
- **Retire `modules/intelligence/` entirely**: the boot-consumed proxy helpers
  (`readApiKey`/`resolveModelId`/`pickDefaultModel` + `ChatSetupError`) relocate to `modules/proxy/`
  (their honest home — they are proxy-endpoint concerns); the `sessions` command relocates to
  `modules/analysis/` (sessions remain the LIVE launch-identity store — threads bind 1:1 to them;
  only their message history froze).
- **Shrink the bus contract**: the six session-scoped `BusEvent` members (emitted only by the
  deleted engine, consumed by nothing) leave `types/events.ts`; `prov.*` members stay.
- **Dev command umbrella**: `chat`, `profile`, and `run` register only in the dev channel — a
  build-channel constant baked by `scripts/build.ts` (the existing `bakedEnv` mechanism) makes
  release binaries omit them, `bun run dev` keeps them, and a non-baked `INFLEXA_DEV=1` env var
  remains as the runtime escape hatch for a shipped binary. The production command surface becomes
  the product: bare `inflexa`, `new`, `ls`, `resume`, `open`, `status`, `sessions`, `analysis`,
  `project`, `prov`, `repair`, `relocate`, `prune`, `auth`, `up`, `down`, `setup`, `sandbox`,
  `config`.

## Capabilities

### New Capabilities
- `dev-commands`: the command-channel contract — which commands are dev-only, how the channel is
  determined (baked build constant, runtime override), and what the production surface is.

### Modified Capabilities
- `intelligence-module`: all requirements REMOVED — the module retires (engine deleted, helpers to
  `modules/proxy/`, sessions command to `modules/analysis/`); the main spec is deleted at sync.
- `event-bus`: the `BusEvent` union shrinks to the provenance members (the session-scoped members
  had no consumers once the engine died).
- `cli-core`: the command registry requirement gains the channel-gated registration rule; the
  `sessions` command joins the product command set.
- `chat-command`: the pending dev-umbrella disposition LANDS — the REPL is registered only in the
  dev channel; the clearing contract updates from "pending demotion" to "demoted".

## Impact

- Deleted: `modules/intelligence/chat.ts` (+ its test). Moved: proxy helpers →
  `modules/proxy/models.ts` (or similar), `sessions.ts` → `modules/analysis/`. Edited:
  `modules/harness/runtime.ts` (import path), `types/events.ts`, `lib/bus.ts` (log summarizer
  branches for dead events), `cli/index.ts` (channel gate + moved imports), `lib/env.ts` +
  `scripts/build.ts` interplay (one new baked var), specs/docs.
- SQLite schema untouched (tables freeze; `sessions` stays live). No harness changes. No new deps.
- Verification is cheap: unit tests + `bun run build` proving the release binary omits the dev
  commands while `bun run dev` keeps them; no live model spend.
