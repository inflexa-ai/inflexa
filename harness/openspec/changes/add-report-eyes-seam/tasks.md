# Tasks: add-report-eyes-seam

## 1. The seam and the connection cache

- [x] 1.1 Add the seam module beside `src/lib/page-capture.ts`: `EyesScope`, `EyesLease`, `AcquireEyes`, and `createStaticEyes(chrome)`. The static realization refuses construction over a config with no endpoint. The seam doc states the no-leak bound: a realization ends what it provisions, with or without a release.
- [x] 1.2 Key the connection cache in `src/lib/chrome.ts` by endpoint: one browser and one semaphore for each `browserUrl`. Evict an entry on disconnect. `withPage` keeps its signature.
- [x] 1.3 Add unit coverage for the keyed cache: two endpoints hold two connections, a disconnect evicts one entry, and the single-endpoint path behaves as before.

## 2. The eyes tool

- [x] 2.1 Add `eyes?: AcquireEyes` to `ExaminePageToolDeps`, with the precedence: `capture`, then `eyes`, then `chrome` as static eyes. The availability gate covers the three.
- [x] 2.2 Run the lease flow in `execute`: acquire, capture against `lease.browserUrl`, release in a finally. Map a thrown acquire onto the `capture-failed` outcome. A thrown release logs and keeps the outcome.
- [x] 2.3 Add tool coverage: one look acquires and releases one lease, and a failed capture still releases. A failed release keeps the capture, and a failed acquire returns the typed outcome.

## 3. The spawn gate

- [x] 3.1 Add `eyes?: AcquireEyes` to `ReportSessionSpawnDeps`, additive. The gate passes when the capture seam, the eyes seam, or a configured endpoint is present.
- [x] 3.2 Add spawn coverage: an eyes seam alone passes the gate, and a composition with none of the three refuses with `no_browser`.

## 4. The composition and the barrel

- [x] 4.1 Add `eyes?: AcquireEyes` to `CoreRuntimeDeps`. The assembly passes `deps.eyes`, else static eyes over `conversation.chrome` when it names a browser, else nothing.
- [x] 4.2 Thread the field through `ReportSessionAgentDeps` into the examine tool.
- [x] 4.3 Export `AcquireEyes`, `EyesScope`, `EyesLease`, and `createStaticEyes` from `src/index.ts`, with the seam comment beside the other seams.
- [x] 4.4 Add assembly coverage: with no `eyes` and no browser in the chrome config, the examine tool reports the no-browser outcome. With a bound seam, the gate passes.

## 5. The gates

- [x] 5.1 Run `bun run format:file` on each changed source file.
- [x] 5.2 Run `tsc -p tsconfig.json`, and run the targeted test files of the changed modules against `CORTEX_TEST_PG_URL`.
- [x] 5.3 Run `openspec validate add-report-eyes-seam --strict`.
