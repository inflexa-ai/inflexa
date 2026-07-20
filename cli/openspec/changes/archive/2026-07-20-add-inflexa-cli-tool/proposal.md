## Why

When an analysis needs a curated reference dataset the user has not installed, the conversation agent dead-ends: it has no way to run `inflexa refs download …` and must send the user out of the session (issue #154, parent #130). The agent should drive the `inflexa` CLI the way it drives `grep` — discover the surface through `--help`, then invoke commands as a subprocess — gated by an in-chat approval that is the security boundary, not a curated per-command allowlist.

## What Changes

- Add a single conversation-agent tool (`run_inflexa`) that takes an argv array and runs the CLI as a subprocess: argv passed to `Bun.spawn` with no shell, `stdin` ignored, `stdout`/`stderr` captured off the TUI alternate screen, bounded by a timeout. It returns exit code and captured output to the model. It is injected into the harness conversation agent through the harness's generic `hostTools` seam — the harness never learns what `inflexa` is.
- Auto-allow provably-safe introspection: an argv that a *dry classification parse* resolves to help/version output (and no action) runs with **no approval prompt**, so the agent explores the surface freely. Every other invocation raises `ctx.ask` and runs only on approval; a rejection ends the turn.
- Classify each argv against the real commander tree in-process (never a string match): help/version → auto-allow; a resolved action → approval; a parse error → returned to the model without spawning. This defeats `-- --help`-style masking because it is commander's own parse deciding, not a heuristic.
- The `always` standing grant keys on the **resolved subcommand path** (e.g. `inflexa refs download`), so approving one dataset does not re-prompt for the next; the prompt still displays the exact argv (via the harness `grantKey` decoupling). Per-analysis, per the approval primitive.
- Refactor the commander registry (`src/cli/index.ts`) from a module singleton into a `buildProgram()` factory so it can be instantiated a second time — with actions replaced by classification sentinels — for the dry classification parse. One binary; the release entry point and the classifier build the same tree.
- Resolve dev vs. release invocation from the baked build channel: a development run invokes `bun run src/index.ts …`; a release binary invokes itself (`process.execPath`).

## Capabilities

### New Capabilities
- `agent-cli-tool`: the conversation-agent tool that drives the `inflexa` CLI as an approval-gated subprocess — the argv contract, the commander-as-oracle classifier, the auto-allow-introspection rule, the `ctx.ask` gate and subcommand-path grant key, subprocess hygiene, and dev/release invocation resolution.

### Modified Capabilities
- `cli-core`: the commander registry is produced by a reusable `buildProgram()` factory (retaining lazy-imported actions and channel-gated dev commands) so the program tree can be built for both real dispatch and dry classification.
- `harness-runtime`: the conversation dependency wiring supplies the `run_inflexa` host tool through the harness `hostTools` seam.

## Impact

- New module for the tool (classifier + spawn + approval-request construction), consuming the `buildProgram()` factory and the harness `defineTool`/`ToolContext`/`AskRequest` (incl. `grantKey`) from the barrel.
- `src/cli/index.ts` — extract `buildProgram()`; `src/index.ts` — call it and dispatch.
- `src/modules/harness/runtime.ts` — pass the tool via `hostTools` in the conversation deps (`:908`).
- Depends on the harness `add-host-conversation-tools` change (the `hostTools` seam + `AskRequest.grantKey`), consumed once that harness is linked/published.
- Precedent reused: `Bun.spawn` capture (`src/lib/container.ts:83-88`), build-channel detection (`env.isDevelopment`, `src/lib/env.ts:152`), `refs download --yes` non-interactive path (`src/modules/refs/commands.ts:123`).
