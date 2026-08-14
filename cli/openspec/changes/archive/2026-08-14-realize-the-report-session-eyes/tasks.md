# Tasks: realize-the-report-session-eyes

## 1. The realization

- [x] 1.1 Add the ephemeral realization beside the other harness-embedder modules. It takes the pinned container runtime, and it gives an `AcquireEyes`.
- [x] 1.2 Pin the browser image by digest, and state why that image serves the plain devtools endpoint.
- [x] 1.3 Start one container for each acquire: a loopback publish of the devtools port, and the workspace root of the scope mounted at its identical path through the descriptor of the runtime.
- [x] 1.4 Give the container its own deadline from inside, thus a lease that no release ends still ends.
- [x] 1.5 Wait for the devtools endpoint, and refuse with a named deadline when it never answers.
- [x] 1.6 Bound how many browsers run at one time, because the page gate of the harness bounds one endpoint alone.
- [x] 1.7 Remove the container on the release. A removal that fails logs, and it does not fail the look.
- [x] 1.8 Remove the container and give the slot back when the acquire itself fails.

## 2. The composition

- [x] 2.1 Bind the realization on the `core` bag of the boot, over the runtime that the sandbox resolution pinned already.

## 3. The coverage

- [x] 3.1 Cover the start: the mount repeats the root, the publish binds loopback, and the deadline rides the container.
- [x] 3.2 Cover the release: the container goes, and a failed removal still resolves.
- [x] 3.3 Cover the two failures: a container that does not start, and one that never answers.
- [x] 3.4 Cover the bounds: a third look waits for a release, and a failed acquire gives its slot back.
- [x] 3.5 Cover the descriptor: the docker form and the podman form of the mount argument differ.

## 4. The gates

- [x] 4.1 Run `bun run format:file` on the changed files under `src/`.
- [x] 4.2 Run `bun run typecheck` and `bun run lint`.
- [x] 4.3 Run the targeted test files of the changed modules, and never the whole suite.
- [x] 4.4 Run `openspec validate realize-the-report-session-eyes --strict`.
