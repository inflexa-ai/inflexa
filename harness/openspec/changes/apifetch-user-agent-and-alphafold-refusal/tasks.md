## 1. The User-Agent

- [x] 1.1 In `src/tools/lib/api-utils.ts`, add the exported constant `HARNESS_USER_AGENT` with the value `inflexa-harness (+https://inflexa.ai)`.
- [x] 1.2 In `runFetch`, make one `Headers` object from the `headers` option before the attempt loop.
- [x] 1.3 If that object has no `user-agent`, set `User-Agent` to `HARNESS_USER_AGENT`.
- [x] 1.4 Give that object to each `fetch` call.
- [x] 1.5 In the doc comment of `apiFetch`, state the default User-Agent and the rule for the header of the caller.

## 2. The AlphaFold absence

- [x] 2.1 In `src/tools/lib/alphafold-client.ts`, add a private `isAbsence(e: ApiError)` that is true for `http_status` 400 or 404 only.
- [x] 2.2 In `fetchAlphaFoldPrediction`, give `null` when `isAbsence` is true, and throw for each other `ApiError`.
- [x] 2.3 Remove the `isUnexpectedApiError` import.
- [x] 2.4 In the header comment and the function comment, state that only 400 and 404 mean absence.

## 3. The tests

- [x] 3.1 In `src/tools/lib/api-utils.test.ts`, add a test: a request with no User-Agent carries `HARNESS_USER_AGENT`, and the other headers of the caller stay.
- [x] 3.2 In the same file, add a test: a caller `user-agent` in lowercase stays the only value.
- [x] 3.3 In `src/tools/bio/alphafold-prediction.test.ts`, add a test: a 403 makes `execute` throw with `HTTP 403`.

## 4. Verification

- [x] 4.1 Run `bun test src/tools/lib/api-utils.test.ts src/tools/bio/alphafold-prediction.test.ts src/tools/lib/alphafold-client.fixtures.test.ts` in `harness/`.
- [x] 4.2 Run `tsc -p tsconfig.json --noEmit` in `harness/`.
- [x] 4.3 Run `eslint` on the four changed source files in `harness/`.
- [x] 4.4 Run `bun run format:file` on the four changed source files in `harness/`.
- [x] 4.5 Call `fetchAlphaFoldPrediction` against the live API for P05089, P14780, P80511, and P38398. Make sure that each call gives a model.
- [x] 4.6 Run `openspec validate apifetch-user-agent-and-alphafold-refusal --strict` in `harness/`.
