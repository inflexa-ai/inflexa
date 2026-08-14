## Why

The harness gives the eyes of a report session through one provisioning seam, and it ships the static realization over a standing sidecar alone. The cli binds neither the seam nor a browser endpoint. Thus `spawnReportSession` refuses every spawn with `no_browser`, and the whole report path is dead in this composition.

A standing sidecar cannot serve the cli. An anchor puts each workspace root in a different user folder, thus no fixed mount set covers the roots that a later analysis makes. The design of the seam names the answer for this host: a browser that appears with one analysis root mounted, and disappears after the look.

## What Changes

- The composition root binds the eyes seam that `assembleCoreRuntime` accepts. Thus a spawn passes its gate, and the report path exists here.
- One acquire starts a container of a pinned browser image, with the workspace root mounted at its identical host path. The lease carries the loopback endpoint of that container, and the release removes it.
- The container carries its own deadline. Thus a lease that no release ends still ends, and a dead process leaks nothing.
- The realization bounds how many browsers run at one time. The page gate of the harness bounds one endpoint, and each look here names a new one.
- The realization runs on the container runtime that the boot pinned already. Thus one boot names one container engine.

## Capabilities

### Modified Capabilities

- `harness-runtime`: the composition root realizes the eyes seam of a report session, beside the page-asset lookup that it realizes already.

## Impact

- `src/modules/harness/eyes.ts` — the realization, the pinned image, and the two bounds.
- `src/modules/harness/runtime.ts` — the binding on the `core` bag, over the pinned runtime that the sandbox resolution gives.
- No new dependency. The container commands run through `lib/container.ts`.
