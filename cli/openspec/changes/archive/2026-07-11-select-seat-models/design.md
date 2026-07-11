## Context

Agent inventory (research §5.4, verified at use sites): the conversation agent and its sub-agents
(planner, literature reviewer, analogy reasoner, report builder) take
`ConversationAgentDeps.model`; the run engine (≈22 catalog step agents, data profile, ephemeral
runner) takes `comp.model` through `buildStepAgent`/`buildSandboxStepDeps`; internal agents
(`synthesisModel`, post-step metadata/summary, target-assessment `decisionModel`) alias the same
id. Two mechanical facts dominate the design: (1) the wire model is bound into each
`ChatProvider` at construction (`ChatRequest` has no model field), so per-agent models mean
per-agent provider instances; (2) the chat turn does not pass a model — the TUI closes over
`runtime.provider` and `runtime.conversationAgent` at boot (`tui/hooks/conversation.ts`), and the
run-engine deps bundles close over their provider at workflow registration. Both facts make a
mid-session swap a *reconstruction* problem, not a field flip. Settled decisions: D-SHARE (one
connection), D-LIVE (live switch, gated on agent idleness, scheduled otherwise, chat turns
count), D-FETCH (dynamic model listing).

## Goals / Non-Goals

**Goals:**

- Per-agent model choice (conversation, sandbox) over the one shared connection — config, setup,
  and palette.
- Live application with the D-LIVE gate; a switch is never observed mid-run/mid-turn.
- Honest provenance across a switch: every activity records the model that actually drove it.

**Non-Goals:**

- Per-agent *connections/providers* (excluded by D-SHARE).
- Exposing the internal agents (synthesis, metadata, decision) as user choices — they alias
  `sandbox` here; splitting them later is config-additive.
- OpenCode-style recents/favorites and variant cycling — the picker is a plain listed choice
  (+free text) in this change; frecency niceties are future polish.
- Changing the harness seam (no `ChatRequest.model`; instance-per-model stands).

## Decisions

**D1 — The user-facing agents are named, closed, and two: `conversation` and `sandbox`.**
`models.agents: { conversation?, sandbox? }`. Internal agents follow `sandbox` (they are run-engine
machinery living in the run deps bundles). Rejected: an open per-agent map keyed by harness agent
id (no user-meaningful granularity today; the deps types don't support per-catalog-agent
providers anyway); exposing synthesis/decision agents (D6's "later config concern" stays later —
adding keys is non-breaking).

**D2 — Per-agent resolution order: `models.agents.<agent>` → `harness.model` → connection default.**
`harness.model` survives as the legacy both-agents fallback so existing configs keep working
untouched; the connection default is cliproxy auto-resolve (family-guarded) or the direct-mode
explicit-model requirement from `configure-model-connection` (which a agent entry satisfies).
Rejected: removing `harness.model` now (needless migration); agent entries defaulting to each
other (surprising coupling).

**D3 — Selections persist to config immediately; runtime application is what the D-LIVE gate
defers.** The palette pick writes `models.agents` via the existing `writeConfig` pattern (the
`ThemePicker` precedent) — durable, single source of truth, visible to the next boot regardless
of what the live runtime does. A separate *pending* runtime state tracks "selected but not yet
applied". Rejected: OpenCode's state-file persistence (a second store to reconcile; OpenCode
needs it for per-agent×per-project frecency, which is out of scope here); apply-only-on-reboot
(explicitly overruled by D-LIVE).

**D4 — The idleness gate is a runtime-owned work gauge; application is reconstruction at the
idle transition.** The harness runtime handle tracks in-flight agent work (analysis runs, data
profiles, chat turns, ephemeral workflows — the trigger surfaces it already owns). A pending
selection applies at the moment the gauge hits idle: rebuild the affected agent's provider
instance(s) and every composition object that closed over them (conversation agent assembly,
run-deps bundles, prov emitters — preserving their construction-time-stamping semantics: the
emitters are reconstructed WITH the new `{provider}/{model}` name, so PR #70's "construction-time
model id" contract stays literally true). Workflow *registrations* are not redone — the deps the
registered workflows consume are reached through the composition's current bundles, and any
indirection needed to make the swap atomic (e.g. a delegating provider handle swapped at idle)
is an implementation detail the tasks own. In-flight work keeps the instances it started with.
Rejected: swapping under live work with per-request routing (contradicts D-LIVE and the
construction-time contract); full runtime reboot on switch (drops DBOS recovery context and chat
session state for a routine action).

**D5 — Dynamic listing reuses the connection's protocol (D-FETCH).** cliproxy: the existing
`/models` fetch (`resolveModelId`'s transport, uncached for the picker). direct/openai-compatible:
`GET {baseURL}/models`. direct/anthropic: `GET /v1/models`. Listing failure degrades to free-text
entry (a `PromptDialog`), never blocks the switch. Rejected: models.dev integration (network
dependency + registry semantics for marginal benefit while the endpoint itself can enumerate).

**D6 — Two palette commands, one picker.** `Switch chat model` / `Switch sandbox model` — two
entries because the agent is the decision, and OpenCode's single command works only because its
model choice hangs off the *current agent*, a concept inflexa's palette does not have. Both open
the same `SelectDialog`-based picker parameterized by agent, boot-gated like `analysis.reprofile`.
The status surface renders the active models from the boot store (`BootState` already carries the
resolved model, currently unrendered) plus a "pending: applies when agent work settles" notice
for a scheduled switch.

## Risks / Trade-offs

- [Reconstruction misses a closure] some object keeps a stale provider/emitter reference and
  records the old model after the swap → the verify task includes a switch-mid-idle provenance
  assertion (new events carry the new name) and a grep-audit of every `comp.provider`/emitter
  consumer (the research doc's agent table is the checklist).
- [The work gauge undercounts] a work kind not in the gauge lets a swap land mid-flight →
  enumerate from the trigger surfaces (profile/run/chat/ephemeral are the only launch paths,
  `harness-runtime` spec) and fail closed: unknown busy state defers the swap.
- [Config written but apply crashes] config and runtime disagree until next boot → acceptable:
  config is the durable truth; boot always reads it; the pending notice tells the user the
  runtime state.
- [Direct-mode listing needs a live endpoint in the picker] → degradation to free text is the
  designed path (D5), and entry validation is the same trust model as hand-editing config.

## Migration Plan

Config-additive (`models.agents` optional; `harness.model` honored). No stored-data changes. The
swap machinery is new code exercised only by the new commands — absent a switch, boot-time
behavior is identical to `configure-model-connection`'s.

## Open Questions

_None blocking. Deferred by decision: recents/favorites (D3/Non-Goals), per-internal-agent
exposure (D1), models.dev enrichment (D5)._
