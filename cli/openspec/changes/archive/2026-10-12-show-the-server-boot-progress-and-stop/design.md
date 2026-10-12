# Design

## Context

- `createServerBoot` (`src/server/boot.ts:50-110`) holds the phase of one server process, and `state()` is the one builder of `ServerState`. The boot work is `ServerBootOpts.boot` (`boot.ts:27-34`), and the holder has no clock.
- `bootServerRuntime` (`boot.ts:117-134`) checks the model connection, calls `ensureProxyReady`, resolves the harness config, and calls `bootHarnessRuntime`. `bootHarnessRuntime` (`src/modules/harness/runtime.ts:468-490`) shares one attempt between the callers that overlap.
- `ensureProxyReady` (`src/modules/infra/setup.ts:3198-3314`) runs the steps of the machine in sequence. `inflexa up` (`src/modules/infra/lifecycle.ts:34`) calls it too, with `DEFAULT_PROXY_READY_OPTS`.
- `composePullIfMissing` (`src/modules/infra/compose.ts:389-402`) pulls with `compose pull` and inherited stdio. No code reads bytes from that output.
- The sandbox transfer has the only byte source: the private `apiPullImage` (`src/modules/libs/transfers.ts:262-326`). It streams `POST /images/create` over the engine socket and sums `progressDetail.current` per layer. `resolveImageTotalBytes` (`transfers.ts:214-238`) sums the layer sizes from `manifest inspect`.
- `splitImageRef` (`transfers.ts:189-195`) cannot parse `name:tag@sha256:…`. The boot images use that form (`PROXY_IMAGE` in `compose.ts:33`, `DEFAULT_IMAGE` in `src/modules/infra/postgres_types.ts:19`).
- `resolveEngineSocket` (`src/lib/container.ts`) gives a socket path for Podman, and `undefined` for Docker. Docker is the first runtime of `runtimeIds` (`container.ts:16`).
- `ServerLifecycle.stopping()` (`src/server/lifecycle.ts:72`) gives the mode of a stop request. `serverRoutes` (`src/server/routes/server.ts:36`) gets the boot holder and the lifecycle.
- Two routes give 503 `unavailable` with `{ phase }`: `requireRuntime` (`src/server/http.ts:80-90`) and the prune of anchors (`src/server/routes/anchors.ts:128-134`).

## Goals / Non-Goals

**Goals:**

- One shape for the boot progress, built in the boot holder, with a clock that a test controls.
- One engine-API pull for the sandbox transfer and the boot.

**Non-Goals:**

- A change to the TUI, to `inflexa server status`, or to the client fetchers. They read only the fields that they read today.
- Byte progress on Docker. Docker resolves no socket path, thus it keeps `compose pull`.
- `stopping` for a signal stop. Ctrl+C, SIGTERM, and SIGHUP call `shutdown()` directly (`src/server/serve.ts:116-121`), not the lifecycle. The issue takes the field from `ServerLifecycle.stopping()`.
- Progress for a step other than `images`, for example the download of the embedder runtime.
- The steps inside the harness runtime boot.

## Decisions

### D1. The wire types

`src/api/server.ts` gets these types, each with a JSDoc block:

```ts
export type BootStepId = "container_engine" | "proxy" | "images" | "containers" | "credential" | "embedder" | "runtime";
export type BootPullProgress = { doneBytes: number; totalBytes: number | null };
export type BootStepRunning =
    | { id: Exclude<BootStepId, "images">; startedAt: string }
    | { id: "images"; startedAt: string; progress?: BootPullProgress };
export type BootStepDone = { id: BootStepId; startedAt: string; endedAt: string };
export type BootProgress = { attemptStartedAt: string; step: BootStepRunning | null; done: BootStepDone[] };

export type ServerBootState = ServerIdentity &
    (
        | { phase: "starting"; boot: BootProgress }
        | { phase: "ready"; connection: ServerConnection }
        | { phase: "failed"; bootError: ServerBootError; attemptStartedAt: string; failedAt: string; failedStep: BootStepId | null }
    );
export type ServerState = ServerBootState & { stopping: ShutdownMode | null };
export type RuntimeUnavailableDetails = { phase: ServerPhase; step: BootStepId | null };
```

`progress` is optional on the `images` variant only, thus the type says which step can carry it. The fields of the `failed` state stay flat beside `bootError`, as the issue asks.

`API_VERSION` stays 1. The change only adds fields, and no CLI client reads them. A version change makes each client refuse each older server, and an added field does not need that.

### D2. `stopping` joins in the routes

`ServerBoot.state()` gives `ServerBootState`. `GET /api/v1/server` and `POST /api/v1/server/boot` in `routes/server.ts` give `{ ...boot.state(), stopping: lifecycle.stopping() }`. The callers that read only the boot take `ServerBootState`: `onSettle`, `printBootOutcome`, `requireRuntime`, `idleBoot`, and the discovery read of `startTestServer`.

Alternative: give the boot holder a reader of the lifecycle. The holder does not need the stop, and the router already has the two holders. Rejected.

### D3. The boot holder tracks the steps

`ServerBootOpts` gets `now: () => Date`, and `DEFAULT_SERVER_BOOT_OPTS` gives `() => new Date()`. The boot work becomes `boot: (progress: BootProgressOpts) => Promise<Result<HarnessRuntime, ServerBootError>>`, with this options type:

```ts
export type BootProgressOpts = {
    readonly onStep: (id: BootStepId) => void;
    readonly onPullProgress: (progress: BootPullProgress) => void;
};
```

The holder obeys these rules:

- Before the first `start()`, the state is `starting` with `attemptStartedAt` set to the start time of the server, `step: null`, and `done: []`. No attempt runs yet. But `runServe` calls `start()` milliseconds after the bind, thus the server start time is the attempt start for a client.
- `start()` sets a new `attemptStartedAt`, `step: null`, and `done: []`. Then it calls `boot` with callbacks that it binds to this attempt. After the attempt settles, these callbacks do nothing. Thus a late call cannot change a later state.
- `onStep(id)` moves the current step, if one runs, to `done` with `endedAt` set to now. Then it makes `id` the current step, with `startedAt` set to now.
- `onPullProgress(p)` sets `progress` only when the current step is `images`. In each other step, the call does nothing.
- An attempt can fail through the `Result` or through a throw. Both give `failedAt` set to now, and `failedStep` set to the id of the current step, or `null`.
- Each step id starts at most one time in an attempt, because each call site of `onStep` runs one time. Thus the `done` list holds at most one entry for each step id, and it has a fixed bound.

### D4. Where each step starts

`ProxyReadyOpts` (`setup.ts:3172-3184`) gets the two callbacks of `BootProgressOpts`. `DEFAULT_PROXY_READY_OPTS` gives callbacks that do nothing, thus `inflexa up` reports nothing. The server boot gives the callbacks of the holder.

| Step | Starts before | Covers |
| --- | --- | --- |
| `container_engine` | `ensureRuntime()` | the runtime check |
| `proxy` | `writeProxyConfig()`, `cliproxy` only | the proxy config, the sign-in check, the cloak |
| `images` | `writeComposeFile()` | the compose file, the pull of the missing images |
| `containers` | `composeUp()` | `compose up`, and the proxy restart in `cliproxy` mode |
| `credential` | `verifyCredentialAtLaunch()`, `cliproxy` only | the credential probe, the warning for a stale pin |
| `embedder` | `ensureEmbedderReady()` | the embedder gate |
| `runtime` | `resolveHarnessConfig()` in `boot.ts` | the harness config, `bootHarnessRuntime` |

The compose file belongs to `images`, because the `compose pull` path reads it. The model connection check in `boot.ts:118-119` comes before each step, thus its fault gives `failedStep: null`.

`bootServerRuntime` in `boot.ts` starts the `runtime` step, not `bootHarnessRuntime`. The issue names `bootHarnessRuntime`, but that function shares one attempt between the callers that overlap. A callback that it gets reaches only the first caller. Also, the runtime has one step, thus a callback in the runtime composition gives nothing more.

### D5. One engine-API pull in `src/lib/container.ts`

`apiPullImage`, `resolveImageTotalBytes`, `splitImageRef`, `hostArchitecture`, `manifestSchema`, and `pullEventSchema` move from `transfers.ts` to `src/lib/container.ts`, beside `resolveEngineSocket`. The sandbox transfer (`modules/libs`) and the boot (`modules/infra`) both use them, and `src/lib/` is the layer for shared infrastructure. The pull function loses its `kind` parameter and its database writes:

```ts
export type EnginePullProgress = { doneBytes: number; layersCompleted: number };
export type EnginePullOutcome = { kind: "completed" } | { kind: "failed"; message: string } | { kind: "unavailable" };
export function pullImageThroughEngine(socket: string, image: string, onProgress: (progress: EnginePullProgress) => void): Promise<EnginePullOutcome>;
export function resolveImageTotalBytes(rt: ContainerRuntime, image: string): Promise<number | null>;
```

- The caller resolves the socket with `resolveEngineSocket`. It treats an error, or `undefined`, as no engine API.
- The function calls `onProgress` after each chunk of the stream, and one time at the end. `onProgress` is a notification: the pull does not guard it, as `stream()` does not guard `onLine`.
- The function never rejects. A `fetch` that throws, or a response that is not OK or has no body, gives `unavailable`, as today. An error event gives `failed` with its message, as today. A read of the stream that rejects gives `failed` with the message of the cause.
- `runImageTransfer` gives a callback that writes the row with the same 500 ms interval (`PULL_PROGRESS_WRITE_INTERVAL_MS`), and the final write. Thus the transfer writes the same rows as today.
- `splitImageRef` gives `{ repo, reference }`. For `name:tag@sha256:…` and `name@sha256:…`, `reference` is the digest. Else it is the tag, or `latest`. The pull sends `reference` as the `tag` value of `POST /images/create`, because Docker and the Podman compat API accept a digest there.
- `resolveImageTotalBytes` reads the manifest of `repo@digest` when the reference pins a digest.

Alternative: export `apiPullImage` from `transfers.ts`, and import it in `compose.ts`. Then the infra module depends on the package store module for a container primitive. Rejected.

### D6. `composePullIfMissing` uses the engine API when it can

`composePullIfMissing(rt, mode, onProgress)` keeps its check of the missing images. When it finds a missing image, it does these steps:

1. Write the start line, as today.
2. Resolve the engine socket. With no socket path, pull with `compose pull` as today.
3. Resolve the size of each missing image, in parallel. `totalBytes` is the sum, or `null` when a size is not known.
4. Pull the missing images in parallel through the engine API, as `compose pull` pulls in parallel. Each pull reports its own `doneBytes`. After each report, give `onProgress` the sum over the pulls, with `totalBytes`. Give no report while the sum is 0, because a status event with no byte figure is not a byte report.
5. Wait until each pull settles. When a pull gives `failed`, give `image_pull_failed`. Its `image` is the reference of the first image that failed, and its message holds the message of the engine.
6. Else, when a pull gives `unavailable`, pull with `compose pull`.
7. Else, run `image inspect` on the reference of each pulled image. When the engine does not hold one, pull with `compose pull`. Thus the download stays in the step `images`, and `compose up` does not pull again.
8. Write an outcome line.

A fallback to `compose pull` reports no more progress. A figure that an engine pull reported before the fallback stays on the step until the step ends.

`ensureProxyReady` gives its `onPullProgress` to `composePullIfMissing`.

### D7. The 503 body names the step

`http.ts` gets `unavailableDetails(state: ServerBootState): RuntimeUnavailableDetails`. It gives the id of the current step in `starting`, `failedStep` in `failed`, and `null` in `ready`. `requireRuntime` and the prune of anchors use it in place of `{ phase }`. The message of `unavailableMessage` does not change.

## Risks / Trade-offs

- [The Podman compat API can store a digest pull under a name that `compose up` does not match.] → The `image inspect` of D6 step 7 sends that case to `compose pull` in the step `images`. Thus a mismatch costs a second pull with no progress, not a failure. No test runs a live engine. A unit test drives the pull against a fake engine on a unix socket (`Bun.serve({ unix })`).
- [`inflexa up` on Podman shows no progress bars of `compose pull`.] → The pull writes a start line and an outcome line. The local-server spec asks for these lines for a boot step.
- [A client of an older server with API version 1 gets no new field.] → The CLI clients read no new field. The version stays, as D1 says.
- [Docker, the first runtime, gives no byte progress.] → The `images` step still gives its start time. A later change that resolves the Docker socket gives bytes to the transfer and to the boot together.
