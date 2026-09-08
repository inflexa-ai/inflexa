## 1. The options and the header parse

- [ ] 1.1 In `src/tools/lib/api-utils.ts`, add `maxRetryDelayMs?: number` to `ApiFetchOptions`, with a doc comment: the ceiling on any single retry wait, the server value included.
- [ ] 1.2 In the same interface, add `sleep?: (ms: number) => Promise<void>`, with a doc comment: a seam for a test, and the shared `sleep` is the default.
- [ ] 1.3 In the same file, add a private `retryAfterMilliseconds(res: Response): number | undefined`. Read `Retry-After` as seconds first, then as an HTTP date relative to now, clamped at zero. Copy the twelve lines of `src/literature/sources/http.ts:45-52`, and do not import them.

## 2. The loop

- [ ] 2.1 In `runFetch`, read `maxRetryDelayMs` with the default 30 000, and `sleep` with the shared default, from the options.
- [ ] 2.2 In the retry branch, set `lastError` to `HTTP <status>` before the wait. Make the wait `Math.min(maxRetryDelayMs, retryAfterMilliseconds(res) ?? retryDelayMs * 2 ** attempt)`.
- [ ] 2.3 Add a last-attempt arm before the generic non-ok arm. When `RETRYABLE_STATUSES` holds the status and no retry remains, return `err({ type: "exhausted", attempts: attempt + 1, lastError })` with `lastError` set to `HTTP <status>` from that response.
- [ ] 2.4 In the `catch` arm, make the wait `Math.min(maxRetryDelayMs, retryDelayMs * 2 ** attempt)`.
- [ ] 2.5 Make each wait go through the `sleep` option.

## 3. The doc comments

- [ ] 3.1 Rewrite the header comment of `apiFetch`. State that a retryable status that outlives the retries resolves to `exhausted`, and that the wait obeys `Retry-After` under the cap.
- [ ] 3.2 Rewrite the comment of `isUnexpectedApiError`. State that a 4xx is expected, unless it is a retryable status that outlived the retries, which arrives as `exhausted`.

## 4. The tests

- [ ] 4.1 In `src/tools/lib/api-utils.test.ts`, next to the 502 test, add a test: a 429 on every attempt with `retryDelayMs: 0` resolves to `exhausted`, `isUnexpectedApiError` gives true, and the attempt count is `maxRetries + 1`. Assert the same with `maxRetries: 0`, where the count is 1.
- [ ] 4.2 In the same file, add a test: a 429, then a 200, with `retryDelayMs: 0`, returns the payload.
- [ ] 4.3 In the same file, add a test: a 429 with `Retry-After: 2`, `retryDelayMs: 0`, `maxRetryDelayMs: 50`, and a `sleep` that records the wait. The recorded wait is 50, and the next attempt returns the payload.
- [ ] 4.4 In the same file, add a test: a 429 with `Retry-After` as an HTTP date in the past gives a wait of 0.

## 5. Verification

- [ ] 5.1 Run `bun test src/tools/lib/api-utils.test.ts` in `harness/`. Do not run the full suite.
- [ ] 5.2 Run `tsc -p tsconfig.json` in `harness/`.
- [ ] 5.3 Run `bun run format:file src/tools/lib/api-utils.ts src/tools/lib/api-utils.test.ts` in `harness/`.
- [ ] 5.4 Run `openspec validate apifetch-spent-retryable-status-and-retry-after --strict` in `harness/`.
