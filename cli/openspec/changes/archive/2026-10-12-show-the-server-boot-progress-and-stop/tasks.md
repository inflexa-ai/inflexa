# Tasks

## 1. The wire types

- [x] 1.1 Add the types of design D1 to `src/api/server.ts`, with a JSDoc block on each type and field. Make `ServerState` the intersection of `ServerBootState` and `{ stopping }`. Keep `API_VERSION` at 1. The typecheck passes after group 4.

## 2. The shared engine-API pull

- [x] 2.1 Move `apiPullImage`, `resolveImageTotalBytes`, `splitImageRef`, `hostArchitecture`, and the two zod schemas from `src/modules/libs/transfers.ts` to `src/lib/container.ts` (design D5). Rename the pull to `pullImageThroughEngine(socket, image, onProgress)`. Remove its `kind` parameter and its row writes.
- [x] 2.2 Make `splitImageRef` give `{ repo, reference }`. A `name:tag@sha256:…` or `name@sha256:…` reference gives the digest. Make `resolveImageTotalBytes` read the manifest of `repo@digest` for a digest reference.
- [x] 2.3 Change `runImageTransfer` to resolve the socket and call the moved functions. Its progress callback writes the row each 500 ms, and one time at the end, as today. With no socket path, it uses the CLI pull as today.
- [x] 2.4 Add tests to `src/lib/container.test.ts`. Cover `splitImageRef` for a bare name, a tag, a registry port, a digest, and a tag with a digest. Drive `pullImageThroughEngine` against a fake engine on a unix socket (`Bun.serve({ unix })`). Make sure of these facts:
  - the `fromImage` and `tag` query values, with the digest as `tag` for a digest reference
  - the sum of the newest `progressDetail.current` of each layer, and the count of the done layers
  - an `error` event gives `failed` with its message
  - a response that is not OK gives `unavailable`
  - a stream that breaks before its end gives `failed`, and the function does not reject

  Make sure that the tests pass.

## 3. The boot pull and the boot steps

- [x] 3.1 Change `composePullIfMissing(rt, mode, onProgress)` in `src/modules/infra/compose.ts` as design D6 says. Write a start line and an outcome line. Add tests to `src/modules/infra/compose.test.ts` with spies on the `src/lib/container.ts` exports. Cover each of these:
  - no socket path pulls with `compose pull`, and reports no progress
  - a socket path pulls each missing image through the engine API, and reports the summed `doneBytes` with the summed `totalBytes`
  - a report with a sum of 0 bytes gives no call of `onProgress`
  - an unknown size gives `totalBytes: null`
  - a `failed` pull gives `image_pull_failed` with the reference of that image and the message of the engine
  - an `unavailable` pull pulls with `compose pull`
  - a completed pull whose `image inspect` misses pulls with `compose pull`
  - the start line and the outcome line in the console output

  Make sure that the tests pass.
- [x] 3.2 Add `onStep` and `onPullProgress` to `ProxyReadyOpts` in `src/modules/infra/setup.ts`, and callbacks that do nothing to `DEFAULT_PROXY_READY_OPTS`. Start each step of the design D4 table in `ensureProxyReady`. Give `onPullProgress` to `composePullIfMissing`.
- [x] 3.3 Add a test of the step order of `ensureProxyReady` in `src/modules/infra/setup.test.ts`. Use spies as the `up` test of `compose.test.ts` does. In `direct` mode, make sure of the order `container_engine`, `images`, `containers`, and `embedder`. In `cliproxy` mode, stop the gate with a `composeUp` failure, and make sure of the order `container_engine`, `proxy`, `images`, and `containers`. Make sure that the tests pass.

## 4. The boot holder and the routes

- [x] 4.1 Change `src/server/boot.ts` as design D3 says. Add `now` to `ServerBootOpts`, give `BootProgressOpts` to `boot`, and bind the callbacks to the attempt. Make `state()` give `ServerBootState`. In `bootServerRuntime`, give the callbacks to `ensureProxyReady`. Start the `runtime` step before `resolveHarnessConfig()`.
- [x] 4.2 Add tests to `src/server/boot.test.ts` with a clock that the test controls. Update the `controlled()` helper for the new `boot` shape. Cover each of these:
  - the state before the first `start()`
  - a step that moves to `done` with its start time and its end time
  - `progress` only on the `images` step
  - `failedAt` and `failedStep` for an error and for a throw
  - `failedStep: null` for a fault before the first step
  - a new attempt that starts with an empty `done` list
  - a call of a callback after its attempt settled, which changes nothing

  Make sure that the tests pass.
- [x] 4.3 Join `stopping` in `GET /api/v1/server` and in the 202 body of `POST /api/v1/server/boot` in `src/server/routes/server.ts` (design D2). Change `printBootOutcome` in `src/server/serve.ts` and `idleBoot` in `src/test_support/server.ts` to `ServerBootState`.
- [x] 4.4 Add `unavailableDetails` to `src/server/http.ts` (design D7). Use it in `requireRuntime` and in the prune of `src/server/routes/anchors.ts`.
- [x] 4.5 Update each `ServerState` literal and each `ServerBoot` fake in the tests, so that `bun run typecheck` passes. Add tests to `src/server/app.test.ts` for each of these:
  - `stopping` is `null`, then `drain` after `POST /api/v1/server/shutdown` with `drain`, and the phase stays
  - the 202 body of `POST /api/v1/server/boot` gives `stopping`

  Add tests to `src/server/http.test.ts` for `details.step` in `starting` with a step, in `starting` before the first step, and in `failed`. Add a test for the prune 503 in `src/server/routes/anchors.test.ts`. Make sure that the tests pass.

## 5. Verification

- [x] 5.1 Run `bun run format:file` on each changed file in `src/`. Make sure that `bun run typecheck` and `bun run lint` pass. Run the changed test files, then run `bun run test` one time. Make sure that each test passes.
