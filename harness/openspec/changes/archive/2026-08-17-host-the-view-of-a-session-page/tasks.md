# Tasks: host-the-view-of-a-session-page

## 1. The contract

- [x] 1.1 Add `reportSessionResourceId` and `buildReportSessionUrl` to `src/contracts/content-url.ts`, beside the preview pair, with the Go-mirror note and the vector note. Export both from `src/contracts/index.ts`.
- [x] 1.2 Add the shared test vectors at `src/__tests__/fixtures/preview-res.json` and `src/__tests__/fixtures/report-session-res.json`, as byte-identical copies of the storage backend's `kernel/contenttoken/testdata` files, exempt from prettier.
- [x] 1.3 Add `src/contracts/content-url.test.ts`, and lock both TypeScript formulas to every vector of the fixture.

## 2. The publisher seam

- [x] 2.1 Add `src/tools/report-session/session-page-publisher.ts`: `SessionPagePublisher`, its mint result, the failure description, and `UnavailableSessionPagePublisher`.
- [x] 2.2 Export the seam from the report-session barrel and from `src/index.ts`.

## 3. The access arm of the preview tool

- [x] 3.1 Add the optional `sessionPages` dep to `createPreviewReportTool`. On a landed page, mint and attach `access` with the URL beside the path on the `rendered` arm.
- [x] 3.2 Carry a refused mint and a thrown realization as the not-granted arm, and keep the render good. An unbound publisher attaches no field.
- [x] 3.3 Cover the arms: the grant, the refusal, the unavailable default, the throw, and the unbound absence.

## 4. The URL seam of the eyes

- [x] 4.1 Add the optional `resolvePageUrl` dep to `createExaminePageTool`, with the `file://` formation as the default at the one call site.
- [x] 4.2 Guard the seam: a throw becomes the typed capture failure, and no look runs.
- [x] 4.3 Cover the seam: the bound resolver names the URL of the look, and a thrown resolver gives the typed failure.

## 5. The composition

- [x] 5.1 Thread `sessionPages` and `resolvePageUrl` through `createReportSessionAgent`.
- [x] 5.2 Add `sessionPagePublisher` and `resolveReportPageUrl` to `CoreRuntimeDeps`, and wire both into the report agent in `assembleCoreRuntime`.

## 6. Verification

- [x] 6.1 Run `tsc --noEmit`, `eslint .`, and `bun test` on the touched suites in `harness/`.
- [x] 6.2 Run `bun run format:file` on each changed source file.
