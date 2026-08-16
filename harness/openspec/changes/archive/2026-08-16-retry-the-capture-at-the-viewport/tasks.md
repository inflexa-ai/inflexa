# Tasks: retry-the-capture-at-the-viewport

## 1. The capture fallback

- [x] 1.1 Add `coverage: "full" | "viewport"` to `PageCapture` in `src/lib/page-capture.ts`, with a JSDoc that states when the viewport arm appears.
- [x] 1.2 Wrap the full-page screenshot: on a throw, screenshot the viewport on the same page, and set the coverage. A second throw propagates.

## 2. The eyes tool passes the coverage through

- [x] 2.1 Carry the coverage onto the look result of `src/tools/report-session/examine-page.ts`, thus the agent reads what the picture shows.
- [x] 2.2 Make sure that a viewport look stamps the seen hash, exactly as a full look does.

## 3. The proof

- [x] 3.1 A test drives the fallback: the first screenshot call throws, the second passes, and the result names the viewport coverage.
- [x] 3.2 A test drives the double failure: both calls throw, and the typed capture failure stays.
- [x] 3.3 Run the targeted suites of the two modules, and `tsc -p tsconfig.json`.
