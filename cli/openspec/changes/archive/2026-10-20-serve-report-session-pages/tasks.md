# Tasks

## 1. The grant store and the publisher binding

- [x] 1.1 Add the page grant store in a new file beside `src/server/browser_session.ts` (design D3). It mints a 32-byte hex token for one analysis id and one thread id. It keeps only the SHA-256 digest of the token. It checks a token against an analysis id and a thread id, and it gives the seconds that a live grant still lives. Before each mint it sweeps the expired grants, and above 256 grants it drops the oldest. Inject the clock. Make sure with a new test file that each scenario of "The server keeps the page grants of the report sessions" passes.
- [x] 1.2 Add the publisher factory over the store in the same file (design D4). The factory binds the analysis of the scope and ignores `auth`. Its mint gives `{baseUrl, token, expiresAt}`, with `expiresAt` in ISO 8601. Make sure with a test that a minted token passes the store check for that analysis and thread. Also make sure that it fails for a different thread.
- [x] 1.3 Add an optional `makeSessionPagePublisher` to the options of `bootHarnessRuntime` (`src/modules/harness/runtime.ts:479`). Put it on `core` only when it is present, and give no `resolveReportPageUrl`. Make sure in `src/modules/harness/runtime.test.ts` that `core.makeSessionPagePublisher` is the given factory when the option is present. Also make sure that it is absent when the option is absent, and that `core.resolveReportPageUrl` is absent in each case.
- [x] 1.4 Make the store one time in `runServe` (`src/server/serve.ts`), and give it to `buildApp` through a new required field of `AppDeps`. Give the publisher factory with `serverBaseUrl(env.serverPort)` to `bootServerRuntime`, which passes it to `bootHarnessRuntime`. Leave the dev `run --plan` call (`src/modules/harness/dev/run.ts:421`) with no factory. Give a new store at each `buildApp` call site, `startTestServer` included. Make sure that `bun run typecheck` passes.

## 2. The page route

- [x] 2.1 Export the shared file-response code from `src/server/routes/files.ts` (design D6). The code is the real-path verdict, the `O_NOFOLLOW` open, the stat, the ETag, the range, and the streamed body. Add a parameter for the headers that differ: the CSP, the cache policy, and the CORS header. The file route keeps its headers. Make sure that `src/server/routes/files.test.ts` passes with no change of its assertions.
- [x] 2.2 Add the page route in a new route file (design D5). Mount it at `/report-sessions` in `buildApp`, before `notFound`. The proof order is `t`, then a public file of `PAGE_ASSETS`, then the cookie `__ic`. The route also gives the 404 cases, the session-folder test, the real-path root `report-sessions/{threadId}/`, and the headers of each response, a 304 and an error included. It gives `Access-Control-Allow-Origin: *` for a public file, and the `Set-Cookie` of an entry request. Make sure with a new test file that each scenario of "The server serves the page of a report session" passes. Include `HEAD`, a 304, an unlisted file under `assets/deps/`, a session folder that is a link, a symbolic link out of the folder, a link to a different session, and a hidden file. Assert the exact 401 message of the spec.
- [x] 2.3 Let `Origin: null` through `hostOriginGuard` only for a `GET` or a `HEAD` under `/report-sessions/` (design D7). Make sure in `src/server/app.test.ts` that the two new scenarios of "The server answers only a request to its own address" pass. Use a real listener, as the existing guard tests do. Make sure that each existing guard test still passes.

## 3. The access route

- [x] 3.1 Add the wire type of the answer `{url, expiresAt}` in `src/api/`, and a fetcher in `src/client/` (design D8). Add the route `POST /report-sessions/:threadId/access` in the route file of 2.2. Mount it under `/api/v1/analyses/:analysisId`, after the analysis guard. Build `url` with `buildReportSessionUrl` and the port of the listener. Make sure with tests that each scenario of "The server mints the access of a report-session page" passes. Include a test where the URL of the answer opens the page through the page route of the same app. Include a test where a URL from the publisher factory of 1.2 opens the page through the same app, thus the one-store rule holds for the two mints.

## 4. The palette command

- [x] 4.1 Add the command `session.open-report-page` ("Open report page", Session category) to `src/tui/commands.tsx` (design D9). The flow reads the open thread with `readOpenThread`, and it refuses a thread that is not a report child. Then it calls the fetcher of 3.1 and opens the URL with `openExternal`. It gives the notices of the requirement. Make sure in `src/tui/report_session_flows.test.ts`, with `fakeClient()`, that each scenario of "The palette opens the page of the open report session" passes.

## 5. Verification

- [x] 5.1 Run `bun run format:file` on each changed file in `src/`. Then make sure that `bun run typecheck` and `bun run lint` give no new error. Then run the full suite one time with `bun run test`, and record the result.
