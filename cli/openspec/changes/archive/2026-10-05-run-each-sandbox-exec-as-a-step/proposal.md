# Remove the exec-callback ingress and the watchdog from the cli runtime

## Why

The harness change `run-each-sandbox-exec-as-a-step` (#569) runs each sandbox exec as one DBOS step that polls the sandbox. The harness has no callback transport and no liveness watchdog now. The cli runtime wired the two, thus the cli must remove that wiring.

## What Changes

- The runtime boot binds no listener for sandbox callbacks. `ingress.ts` and the `ingress_failed` boot error are removed.
- The sandbox client config of the cli has no `transport` and no `cortexBaseUrl`.
- The boot registers the sandbox reaper and the notification sweep, and no watchdog.
- The shutdown closes no callback listener.
- The barrel requirement drops the exec-callback envelope helpers, because the harness exports them no more.
- The sandbox-step agent deps carry no `runId`, `stepId`, `workflowId`, or `nextFunctionId`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-runtime`: the boot sequence, the hygiene workflows, the shutdown, and the barrel surface. The exec-callback ingress is removed.

## Impact

- `src/modules/harness/runtime.ts`, `src/modules/harness/run_deps.ts`, and `src/modules/harness/dev/run.ts`.
- `src/modules/harness/ingress.ts` and its test are removed.
- The cli needs a harness release that holds the change `run-each-sandbox-exec-as-a-step`, and a `sandbox-base` image from the same change.
