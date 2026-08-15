## 1. The collection

- [x] 1.1 Make the citation collection in `src/report-model/pin-snapshot.ts`. It lists the runs, reads each synthesis record under a 1 MiB cap, and extracts the PMID keys leniently.
- [x] 1.2 Fill `snapshot.citations` with the deduped keys in code-unit order. Correct the stale comment that says nothing consumes a pinned citation list.
- [x] 1.3 Unit tests: the key shape, the dedupe, the sort, the absent file, the malformed JSON, the over-cap file, and the failed run listing.

## 2. The seam

- [x] 2.1 Give `ReportSessionRuntimeDeps` an optional `resolveWorkspaceRoot`, and thread it into the pin. An absent seam pins no citations, and it logs one warning.
- [x] 2.2 Wire the seam at the composition root that builds the runtime, from the resolver that the session tools already use.
- [x] 2.3 Tests: the pin with the seam carries the citations, and the pin without the seam lands with none.

## 3. The teaching

- [x] 3.1 Extend `src/prompts/report-session.ts`: the literature references compose as citation blocks, against the pinned citation ids. A citation outside the pinned evidence does not resolve, and the agent reports it.

## 4. The gates

- [x] 4.1 Run the targeted suites of the touched modules only. The pin suite is a Postgres suite, thus it runs with `CORTEX_TEST_PG_URL` at the podman container.
- [x] 4.2 Run `bun run format:file` on the touched `src/` files, then `tsc -p tsconfig.json`.
