## Context

The conversation agent cannot run the `inflexa` CLI, so an analysis that needs an uninstalled reference dataset dead-ends (issue #154, parent #130). The three predecessors landed: the ref-store mount is re-checked at every sandbox create (#151/PR157), `inflexa refs` has machine-readable output (#152/PR158), and the `ctx.ask` approval primitive exists (#153/PR159).

The design treats `inflexa` like `grep`: the agent learns the surface via `--help` and invokes commands as a subprocess. The security boundary is the in-chat approval, not a curated per-command allowlist. Two facts constrain the implementation:

- The commander registry is a module singleton (`src/cli/index.ts:7`, `cli.exitOverride()` at `:68`); classification needs a second instance, so it must become a factory.
- The harness `ctx.ask` primitive keys an `always` grant on the same string it displays. The companion harness change (`add-host-conversation-tools`) adds a `grantKey` so the prompt can show the exact argv while the grant keys on a broader class.

## Goals / Non-Goals

**Goals:**
- One tool, one binary, no per-command build-time allowlist.
- Free surface exploration via `--help`/`--version`; every action approval-gated.
- `always` that keys on the subcommand path so a second dataset does not re-prompt.
- A classifier that cannot be fooled by an argv that commander's own parse would not be fooled by.

**Non-Goals:**
- No dedicated `refs` tool, no refs-specific branch in v1 (the prompt shows the argv, not a computed download size — a later refs-aware enrichment, and a streamed download-progress widget, are deferred).
- No planner ref-awareness (that is #155); for now the agent may need to `inflexa refs list` (which prompts) to inspect state.
- No new network path, no `download(url)` tool — only the existing catalog-pinned CLI is reachable.

## Decisions

### One tool with an argv array; the approval prompt is the boundary

`run_inflexa({ argv: string[] })`. The argv array goes straight to `Bun.spawn` as an argv (no shell), so there is nothing to tokenize and no metacharacter to interpret; a single whitespace-bearing string element is defensively split shell-style first. No per-command allowlist gates which commands the agent may name — the human sees the exact argv in the approval and decides. A shell-tool mental model: you do not maintain a per-flag allowlist for `grep`; you gate execution.

### Classification is commander's own parse, halted at the action boundary

Rejected: a string check for `--help` (the issue's own caution — `refs download x -- --help` masks an action) and a hand-written argv walker (re-implements commander's `--` terminator, option-argument, and abbreviation semantics — the brittle path).

Chosen: build the real tree via `buildProgram()`, replace each command's action with a sentinel that throws the resolved command, `exitOverride()`, silence output via `configureOutput`, then `parseAsync(argv, { from: "user" })` and read the throw:
- `CommanderError` code `helpDisplayed` / `help` / `version` → introspection → **auto-allow**.
- the sentinel → a real action → **approval** (read the resolved subcommand path by walking `.parent`, and the CLI-parsed options).
- a parse-error code (`unknownCommand`, `unknownOption`, `missingArgument`, `excessArguments`, `invalidArgument`) → **return to the model**, no spawn, no prompt.

Verified in `node_modules/commander/lib/command.js` (v15.0.0): in `_parseCommand`, `_outputHelpIfRequested` (line 1597, throws under `exitOverride`) runs strictly before the `preAction` hook (1614) and the action (1616), and `_chainOrCallHooks` walks `_getCommandAndAncestors()` (1514) so a root hook fires for a nested action. The registry has no custom `argParser` and no existing hooks, so a classification parse has no side effects beyond the help output we silence. The classifier is therefore exactly as correct as the CLI's real dispatch, because it *is* that dispatch, stopped one line before the work — nothing can present as help past commander without also masking in the real run.

### Show the exact argv, grant the subcommand path

`AskRequest.command` = the exact argv (honest "this runs"); `AskRequest.grantKey` = the resolved subcommand path only, no argument/option values (e.g. `inflexa refs download`). The classifier already produced the path, so the key falls out for free. `always` on one dataset then covers the next on that subcommand path, per analysis (the grant is `(analysis_id, grantKey)`).

### `buildProgram()` factory

Extract the singleton `cli` into a factory returning a fresh root; `src/index.ts` calls it for dispatch, the tool calls it (in a classify variant with sentinel actions) for the dry parse. One binary, one registration, no shared parse state between the two instances.

### Dev vs release invocation

From `env.isDevelopment` (`src/lib/env.ts:152`, off the baked `INFLEXA_BUILD_CHANNEL`): a dev run spawns `bun run src/index.ts …` (dev is `bun run src/index.ts`); a release binary spawns `process.execPath …` (the compiled binary is itself). Precedent: the `Bun.spawn` capture at `src/lib/container.ts:83-88`.

## Risks / Trade-offs

- **[A TUI-launcher argv (`new`, bare `inflexa`) resolves to an action and, if approved, renders a TUI into a non-TTY pipe and could hang.]** → Under "no per-command flag" we do not special-case it; the defenses are the approval prompt (nothing runs silently) plus a spawn timeout that kills a non-exiting child, plus `stdin: ignore`.
- **[A bare-subcommand grant key lets an `always` cover a more dangerous flag on the same path — e.g. `always inflexa down` later covering `inflexa down --delete-data`.]** → Accepted deliberately (the user chose the subcommand-path key). The mitigation the `grantKey` split buys: the displayed `command` at the moment of *any* prompt is the exact argv including the flag, so nothing destructive is hidden when consent is given; only silent re-runs of the same subcommand are in scope. Captured as an explicit comment at the grant-key construction site.
- **[Read-only commands (`refs list`, `refs verify`) are not introspection, so they prompt.]** → Accepted for v1. It largely evaporates once #155 feeds the installed-ref inventory to the planner host-side, so the agent rarely needs to shell `refs list`; genuine actions (downloads) should be gated regardless.
- **[The classifier could drift from real dispatch.]** → It cannot meaningfully: both build the same tree from `buildProgram()`. A command added to the registry is seen by both.
- **[Depends on the harness `add-host-conversation-tools` change.]** → The tool consumes `hostTools` and `AskRequest.grantKey` from the barrel; the CLI builds against the linked local harness until the pin advances (per the harness-dist workflow), matching how #153's CLI side shipped ahead of the registry pin.
