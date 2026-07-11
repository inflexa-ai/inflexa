## Why

With the model connection user-owned (`configure-model-connection`), one model id still drives
every agent (the CLI's D6 shortcut: "one model id in the cli config; splitting is a later
config concern" — `openspec/changes/archive/2026-07-03-embed-execute-analysis/design.md`). Users
need to run the conversational agent and the sandbox agents on different models of the SAME
connection (D-SHARE), pick them during setup/config, and switch them from the command palette —
live, without restarting, but never underneath in-flight agent work (D-LIVE). This is the
OpenCode-parity surface (`Switch model`) adapted to inflexa's two user-facing agents. Research:
`docs/research_model_provider_selection.md` §5.4, §6.3.

## What Changes

- A `models.agents` config map with the two user-facing agents — `conversation` (chat agent + its
  sub-agents) and `sandbox` (step agents, data profile, ephemeral runner) — each an optional
  model id over the one shared connection. Internal agents alias a user-facing agent: run
  synthesis, post-step metadata/summary, and target-assessment follow `sandbox`. Resolution per
  agent: `models.agents.<agent>` → `harness.model` (legacy both-agents fallback) → the connection's
  mode default.
- The composition builds **one provider instance per distinct agent model** over the shared
  connection (the harness contract from `expose-provider-config`); provenance stamps each
  activity with the agent that drove it.
- **Command palette**: `Switch chat model` and `Switch sandbox model` commands opening a model
  picker; the picker lists models dynamically from the connection (`/models` on the proxy or an
  OpenAI-compatible endpoint, `/v1/models` on Anthropic) with free-text entry as fallback
  (D-FETCH).
- **Live switching gated on agent idleness (D-LIVE)**: a selection persists to config
  immediately; it applies to the runtime immediately when no agent work is in flight, otherwise
  it is scheduled and applied when the last work settles. Agent work = analysis runs, data
  profiling, chat turns (and their ephemeral workflows). In-flight work completes — and records
  provenance — under the model that started it.
- The TUI surfaces the shared connection's identity (provider slug + mode) and the active agent
  models (status affordance fed by the boot store), plus the pending state of a scheduled switch.
- A switch never disturbs an in-progress streamed response: the swap waits for the turn boundary
  (in-flight work completes uninterrupted on the model that started it).

## Capabilities

### New Capabilities

- `agent-model-selection`: per-agent model configuration and resolution, the palette switch
  commands, the dynamic model listing, and the live/scheduled application semantics.

### Modified Capabilities

- `harness-runtime`: the analysis-run and conversation dep-realization requirements stop sharing
  one chat provider — each agent's deps receive the provider bound to that agent's resolved model,
  over the shared connection.

## Impact

- `cli/src/lib/config.ts` (`models.agents`), `cli/src/modules/harness/config.ts` + `runtime.ts` +
  `run_deps.ts` (per-agent resolution, two provider instances, swap machinery),
  `cli/src/modules/proxy/models.ts` (listing reuse), `cli/src/tui/commands.tsx` + a picker dialog
  (palette), `cli/src/tui/hooks/boot.ts`/status surfaces, tests throughout.
- Depends on `configure-model-connection` (connection facts, front-door construction) — written
  against its post-archive spec text.
- Backwards compatible: no `models.agents` ⇒ both agents resolve identically to today's single id.
