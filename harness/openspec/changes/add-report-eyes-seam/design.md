## Context

The eyes of a report session run one capture: navigate to the page, wait for readiness, and return the screenshot with the faults. The transport under that capture is fixed at assembly. `ChromeConfig.browserUrl` names one standing sidecar, and the module caches one connection forever (`src/lib/chrome.ts`). The `capture` field on the examine tool replaces the whole capture, and it exists for tests.

The managed deployment runs a standing sidecar over one shared workspace volume. Thus one static mount covers every analysis, and one endpoint serves every look. The CLI cannot do this. Each workspace root is an anchored user folder, thus no fixed mount set exists. The CLI needs a browser that appears with one analysis root mounted, and disappears after the look.

The spawn gate reads the same availability. A composition with no eyes refuses every spawn with `no_browser` (`src/app/spawn-report-session.ts`). The parallel switch work (#314) binds to the current spawn deps, thus this change must stay additive.

## Goals / Non-Goals

**Goals:**

- One seam that answers "where does a browser come from" for one look.
- The harness keeps every page behavior: the `file://` URL, the readiness wait, and the seen stamp.
- The managed composition keeps zero change.
- The gates stay additive, thus the #314 work does not break.

**Non-Goals:**

- The CLI realization (the ephemeral container). It is a companion change in the `cli` subsystem.
- HTTP serving of the page. The `file://` contract stays.
- The old report path. `preview_snapshot` keeps its behavior until #313.

## Decisions

### D1. The seam is endpoint-level, not capture-level

`AcquireEyes = (scope: EyesScope) => Promise<EyesLease>`. The alternative was a per-embedder `CapturePage` realization. That shape forces each embedder to rewrite the connect and the readiness wait. It also multiplies when a future tool interacts with the page. The endpoint seam keeps one page implementation in the harness, and the embedder owns provisioning alone.

### D2. The scope carries the analysis id and the workspace root

`EyesScope = { analysisId, workspaceRoot }`. A realization that starts a container must mount the root at its identical host path. The tool resolves the root already, thus the scope hands it over, and the realization holds no second resolver.

### D3. The lease is one look

`EyesLease = { browserUrl, release() }`. The tool acquires before the capture and releases in a finally. A per-session lease was considered and dropped: a look is a rare event, and a session-long browser is a standing cost with no owner. A future interactive tool can hold one lease across many operations, because the lease shape does not bind the duration.

### D4. A lease cannot leak what it provisions

The release in the finally is hygiene, and it is not the guarantee. A process can die between the acquire and the finally, thus no caller-side release prevents every leak. The guarantee sits on the realization: it bounds the life of what it provisions, thus a lease that no release ends still ends. The ephemeral realization gives its container a hard lifetime, and the static realization provisions nothing.

A failed release logs, and it does not change the outcome of the look. The capture already succeeded, and the bound of the realization reaps the endpoint.

### D4b. The realization bounds the count of its browsers

D4 bounds the life of one lease. It does not bound how many browsers live at one time. The page gate of `chrome.ts` bounds one endpoint. Thus a realization that starts a browser at a new endpoint for each look meets no bound in the harness.

The count bound sits on the realization, and not in the harness. The harness has no sensible default for an arbitrary realization: a container runtime, a remote browser pool, and a standing sidecar each hold a different resource. A realization knows its own resource, thus it sets the number. The static realization provisions nothing, and one standing sidecar answers every look.

### D5. The chrome connection cache keys on the endpoint

Today `getBrowser` pins the first endpoint forever, and one module semaphore covers every page. The cache becomes a map keyed by `browserUrl`, and each endpoint gets its own semaphore. A disconnect evicts its entry. The old path names one endpoint, thus its behavior does not change. An ephemeral endpoint disconnects when its container dies, thus the map does not grow.

The eviction is event-driven, and no sweep runs over the map. The socket close of a dead browser raises the disconnect event, thus a browser that dies in the normal way evicts its own entry. A browser that dies with no event leaves one entry that nothing removes. The cost is one dead entry for one endpoint URL that no later look names again.

The design rejects two other evictions. A blanket forget after each release reconnects on every look: the static realization must keep its connection to the standing sidecar across looks, thus that eviction regresses the managed path. A per-lease disposable flag puts a detail of the connection cache into the seam, and the seam answers one question alone.

### D6. The gates widen additively

The examine tool and the spawn each accept `eyes?` beside `chrome` and `capture?`. The gate passes when any of the three is present. A replacing change was rejected, because #314 binds to the current deps in parallel. The `chrome` arm retires with #313, and the seam then stands alone.

### D7. Precedence in the examine tool

`capture` wins, then `eyes`, then `chrome` as static eyes. `capture` replaces the whole transport, and tests inject it. When `eyes` serves the look, the tool acquires a lease and runs the shared capture against `lease.browserUrl`.

The chrome arm of the tool serves a direct construction alone, for example the tool tests. In the assembled runtime the assembly wraps first (D8), thus the tool arm never fires there.

### D8. The static realization ships in the harness

`createStaticEyes(chrome)` returns the configured endpoint with a no-op release. The assembly wraps `conversation.chrome` into static eyes when it names a browser. Thus the managed composition changes nothing, and `CHROME_BROWSER_URL` keeps working.

A config with no endpoint refuses at construction. An endpoint-less static realization can only fail at the first look, thus the construction refusal moves the fault to the boot.

### D9. An acquire failure is a typed outcome

The tool maps a thrown acquire onto the `capture-failed` outcome, with the detail from the error. The seam speaks the throw protocol, the same as the capture seam beside it.

## Risks / Trade-offs

- [Two transport fields coexist: `chrome` and `eyes`] → One precedence rule, stated in D7 and in the tool comment. The ambiguity dies with #313.
- [A lease can outlive a broken realization and leak a container] → The realization bounds the life of what it provisions (D4). Thus a lost release still ends the container, and the release in the finally is hygiene.
- [A cold start inflates each look] → Accepted. The realization bounds it, and a look is rare beside the model turns around it.
- [A per-endpoint semaphore changes the global page cap] → The old path names one endpoint, thus its cap semantics stay identical.

## Migration Plan

The change is additive. No consumer breaks, and the managed composition keeps zero change. The CLI companion change binds its container realization to `CoreRuntimeDeps.eyes` after this lands. A rollback removes the seam field, because nothing outside this change consumes it yet.

## Open Questions

None.
