## Why

The harness is replacing its unreliable, blocking ephemeral executor with
durable one-step ad hoc analysis and requires a dedicated low-cost utility model
for specialist/resource routing. As the embedder, the CLI must expose that model
tier through the same connection, resolution, switching, and status contracts as
its existing conversation and sandbox tiers while deleting obsolete ephemeral
resource wiring.

## What Changes

- Add `models.agents.utility` as the third required resolved agent-model tier,
  served through the existing shared model connection and the same override →
  legacy fallback → connection-default resolution chain.
- Construct and inject a utility provider/model into the harness composition,
  sharing a provider instance with another tier when their resolved model ids
  are equal.
- Extend palette switching, busy-state deferral, live swappable handles, runtime
  status, and sidebar visibility to the utility tier exactly as for conversation
  and sandbox.
- Treat utility-model work as ordinary in-flight agent work for model-switch
  safety.
- **BREAKING**: remove the CLI's ephemeral resource-limit configuration and
  ephemeral workflow dependency wiring.
- Preserve the harness's temporary pre-launch sweep for legacy
  `ephemeral:*` DBOS rows during the supported upgrade window, without
  registering or constructing a new ephemeral workflow.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-model-selection`: expand the shared-connection agent model map,
  resolution, provider reuse, live switching, and status surfaces from two tiers
  to conversation, sandbox, and utility.
- `harness-runtime`: inject the resolved utility provider/model into the
  harness-owned ad hoc router, remove ephemeral workflow/resource composition,
  and retain only the bounded legacy-row migration hook.

## Impact

- CLI config schema/read/write helpers and compatibility fallback.
- Harness runtime boot/composition, swappable provider registry, in-flight work
  tracker, model picker commands, boot/status state, and sidebar rendering.
- Removal of ephemeral resource settings and dependency builders/tests.
- Requires the coordinated harness change `unify-adhoc-analysis-execution`;
  neither subsystem redefines the other's behavior.
