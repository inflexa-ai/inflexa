# Tasks

Each path is relative to `cli/`.

## 1. The runtime

- [x] 1.1 Remove `src/modules/harness/ingress.ts`, its test, the `startIngress` seam, and the `ingress_failed` boot error.
- [x] 1.2 Remove `transport` and `cortexBaseUrl` from the sandbox client config in `runtime.ts`.
- [x] 1.3 Remove the `registerWatchdog` seam and its registration. Keep the reaper and the notification sweep.
- [x] 1.4 Remove `runId`, `stepId`, `workflowId`, and `nextFunctionId` from the step agent deps in `run_deps.ts`.

## 2. The Purpose section

- [x] 2.1 Rewrite the Purpose of `harness-runtime`. It named the transport choice and the callback ingress.

## 3. The verification

- [x] 3.1 Link the working-copy harness with `bun run harness:local`, then run the cli typecheck and `bun test`.
