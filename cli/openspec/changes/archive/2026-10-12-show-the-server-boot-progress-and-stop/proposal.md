# Proposal

## Why

A client of the local server cannot show the progress of the boot or a stop that runs (issue #643). `GET /api/v1/server` gives `starting` with no detail (`src/server/boot.ts:57-58`), and the boot does long steps in sequence: an image pull on a new machine can take minutes. A stop refuses each new chat turn with 503 `draining` (`src/server/routes/conversation.ts:364-367`), but the phase stays `ready`. Thus a client learns of the stop only when a send fails. The consumer is Flamme (inflexa-ai/himmel#69): it shows the boot progress in the chat and run areas, and it blocks a send while the server stops.

## What Changes

- Each `ServerState` gets `stopping: "now" | "drain" | null`, from `ServerLifecycle.stopping()`. A server can stop in each boot phase, thus the stop is a field apart from the phase.
- The `starting` state gets `boot`. It gives the start time of the attempt and the step that runs now, with its start time. It also gives each step that ended, with its start time and its end time.
- The step ids are `container_engine`, `proxy`, `images`, `containers`, `credential`, `embedder`, and `runtime`. The `proxy` and `credential` steps run only in `cliproxy` mode.
- The `images` step gets `progress: { doneBytes, totalBytes }` when the pull reports bytes.
- The `failed` state gets the start time of the attempt, the time of the failure, and the id of the failed step. The id is `null` for a fault outside a step.
- The boot work of `ServerBootOpts` gets the callbacks of the boot holder: one for the start of each step, and one for the byte progress of the pull. `ensureProxyReady` calls them, and the server boot calls the step callback for the `runtime` step.
- The 503 `unavailable` body of a route that needs the runtime adds the step to `details`, beside `details.phase`.
- The byte progress comes from one shared engine-API pull. The private `apiPullImage` of the sandbox transfer (`src/modules/libs/transfers.ts:262-326`) moves to `src/lib/container.ts` with a progress callback, and it learns the `name:tag@sha256:…` references of the boot images. The boot pulls each missing image with it when the engine socket resolves. Thus Podman reports the bytes. Docker resolves no socket path today, thus it keeps `compose pull` and reports no progress.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: a new requirement gives the stop and the boot progress in `GET /api/v1/server`. It also gives the times and the step of a failed boot, and `details.step` of the 503 body. A second new requirement gives the pull of the missing boot images through the engine API, with the byte progress. With no engine socket, the boot uses `compose pull`.

## Impact

- Wire types: `src/api/server.ts` gets the step id type, the boot progress types, and the new fields of `ServerState`. The change only adds fields, thus `API_VERSION` stays 1.
- Server: `src/server/boot.ts` (the step state, the clock), `src/server/routes/server.ts` (the `stopping` field), `src/server/http.ts` and `src/server/routes/anchors.ts` (`details.step`), `src/server/serve.ts` (the composition).
- Infra: `src/modules/infra/setup.ts` (`ensureProxyReady` reports each step), `src/modules/infra/compose.ts` (the pull of the missing images).
- Shared code: `src/lib/container.ts` gets the engine-API pull and the image size read. `src/modules/libs/transfers.ts` calls them, with the same row writes as today.
- Test support: `src/test_support/server.ts` (`idleBoot`), and each test that builds a `ServerState` literal.
- `inflexa up` calls the same gate. On Podman, its pull shows a start line and an outcome line in place of the progress output of `compose pull`.
- No new dependency. No change to the TUI, to `inflexa server status`, or to the client fetchers: they read only the fields that they read today.
