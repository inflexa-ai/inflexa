## Why

The eyes of a report session reach a browser only through a fixed `browserUrl`, and the connection is a process singleton pinned to one endpoint. The CLI anchors each workspace root in a different user folder. Thus no standing sidecar can mount a fixed tree that sees every page. Thus every spawn refuses with `no_browser` there, and the report path is dead in that composition.

## What Changes

- Add an endpoint-level provisioning seam for the eyes: `AcquireEyes = (scope: EyesScope) => Promise<EyesLease>`. The embedder supplies where a browser comes from, and the harness keeps every page behavior: the `file://` navigation, the readiness wait, and the seen stamp.
- A lease carries a `browserUrl` and a `release()`. The eyes tool acquires one lease for one look, and it releases the lease after the look, in a finally.
- Ship `createStaticEyes(chrome)`, the fixed-endpoint realization over a standing sidecar. The release is a no-op. The managed deployment keeps zero change, because the assembly wraps a configured `browserUrl` into static eyes.
- Key the chrome connection cache and the page semaphore by endpoint. Today the module pins the first endpoint forever, and a per-lease endpoint cannot connect.
- Widen the eyes gates additively. The examine tool and the spawn each accept `eyes?` beside `chrome` and `capture?`, and the gate passes when any of the three is present. The additive shape keeps the parallel switch work (#314) unbroken.
- Thread the seam through the composition: `CoreRuntimeDeps.eyes?`, the report-session agent deps, and the barrel exports.
- True up the spec: the `no_browser` spawn refusal exists in the code today, and no spec carries it.

## Capabilities

### New Capabilities

None. The seam exists for the eyes of a report session alone, thus its contract lands inside `report-verification`.

### Modified Capabilities

- `report-verification`: the eyes tool reaches the browser through the eyes seam of the composition. One look acquires one lease and releases it after the look. The typed no-browser outcome and the `file://` navigation stay.
- `report-session-spawn`: the spawn refuses a composition with no eyes, with the typed reason `no_browser`. The code does this today, and the delta records it.

## Impact

- `src/lib/chrome.ts` — the connection cache and the semaphore key on the endpoint.
- New seam module beside `src/lib/page-capture.ts` — `AcquireEyes`, `EyesScope`, `EyesLease`, `createStaticEyes`.
- `src/tools/report-session/examine-page.ts` — the lease flow around the capture.
- `src/app/spawn-report-session.ts` — the additive `eyes?` dep and the widened gate.
- `src/runtime/assemble.ts`, `src/agents/report-session-agent.ts`, `src/index.ts` — the seam threads through the composition and the barrel.
- Out of scope: the CLI container realization (a companion change in the `cli` subsystem), the old report path (#313), and any HTTP serving of the page.
