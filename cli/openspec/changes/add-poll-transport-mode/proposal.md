# CLI poll transport: no callback ingress at boot

## Why

The harness `add-poll-transport-mode` change makes the host **poll** the sandbox
for results (the new default) instead of listening for a pushed callback. Poll is
the right mode for a local-first CLI: the sandbox initiates nothing, so there is
no host ingress to be unreachable (#27) and a restarted host always dials from its
current identity (#41). The CLI's exec-callback ingress — a loopback HTTP listener
that bridged sandbox callbacks onto DBOS topics — has no job in poll mode.

## What Changes

- **The CLI wires `SandboxTransport = "poll"`** into `createSandboxClient` at its
  composition root (`modules/harness/runtime.ts`). The value rides to the
  container as `SANDBOX_TRANSPORT` and selects `awaitExec`'s poll loop.
- **Boot starts no ingress in poll mode.** `bootHarnessRuntime` binds the
  exec-callback listener only in callback mode; in poll mode it uses a no-op
  ingress (`noopExecIngress`) that binds nothing, advertises an empty
  `cortexBaseUrl`, and stops cleanly. The sandbox client's `cortexBaseUrl` is
  therefore empty in poll mode — the sandbox never dials out, so the harness
  ignores it.
- **The exec-callback ingress requirement becomes callback-mode-only.** Its
  listener, envelope, and delivery contract are unchanged for a callback embedder;
  the CLI simply does not bind it.

## Capabilities

### Modified Capabilities

- `harness-runtime`: boot sequences without the callback listener in poll mode
  (the CLI's default); the exec-callback ingress is scoped to callback mode.

## Impact

- `modules/harness/runtime.ts` (transport const, poll-mode boot branch, transport
  threaded into `createSandboxClient`), `modules/harness/ingress.ts`
  (`noopExecIngress`, docblocks). Consumes the harness `SandboxTransport` seam.
- Pairs with the harness `add-poll-transport-mode` change. Closes #27 and #41.
