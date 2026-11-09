# Proposal

## Why

The harness change `add-source-build-session` defines a `BuildSession` interface and an `install_from_source` conversation tool. The interface does nothing until an embedder binds it, and the CLI is the embedder: it owns the container runtime, the egress wall, the acquisition flights, and the farm composition. Without this change, a source package still cannot reach a store that the CLI serves.

## What Changes

- The CLI binds the `BuildSession` interface in the conversation composition deps, and the harness adds the `install_from_source` tool to the conversation roster through that binding.
- A session is a held provisioner-image container whose entrypoint override applies the egress allowlist and then holds: no store mount, a scratch volume for the pristine snapshot and the working copy. The exploration phase walls the git host alone; an approved plan restarts the container under the approved list. Each command arrives through `docker exec` / `podman exec` with its own timeout, in a fresh shell; an exec runs as the non-root user by default and may be marked as root, which its ask states.
- A session egress class, separate from the acquisition classes: the git host of the source and its submodules, the dated Ubuntu snapshot host for apt, and the Python index and the pak repositories for build dependencies. The plan names each host and the user approves the list. The snapshot date is the build date of the shared base image.
- The host makes the source snapshot before the session commands: a clone at the resolved commit, or a copy of the local folder hashed with the tree hash over the copy. The session works on a working copy, and the clean run reads the pristine snapshot alone. A private repository authenticates with `GITHUB_PAT` in the environment of the clone command alone, and the token never reaches a later exec, the plan, or the build record.
- The clean run is a new `acquire-source` provisioner flight: the run takes the pristine snapshot and the approved build script, writes the artifact into the pool, and stages the graph nodes. The flight then runs the unchanged tail — the load check inside the sandbox image (with the `ldd` link rule), the graph commit, and the farm extension. The source flight row is created at the clean run, keyed by the qualified pin, and the retry route refuses a source row.
- The farm lock entry of a source-built package carries a `source` field read from the build record, and a source-built R package links under `r/source`. The composition refuses two store directories of one package name in one farm — the Python path that exists today and the R path that skips in silence today — and a pool query that two directories of one identity answer refuses with both named. A fork and an index package of one name and version never share a farm, and neither is picked in silence.
- A refused flight settles as a terminal `failed` row, exactly as an index acquisition does.

## Capabilities

### New Capabilities
- `source-build-session`: the CLI realization of the build session — the held container, the exec channel, the session egress class, the source snapshot, and the clean-run flight.

### Modified Capabilities
- `package-store-management`: a flight that launches a source session or its clean run carries the session egress class, beside the two acquisition classes. The acquisition classes themselves do not change.

## Impact

- `cli/src/modules/libs/` — a new session module (container lifecycle, exec channel, snapshot, egress), `provisioner.ts` (the session egress class and the `acquire-source` launch), `store_flight.ts` (the `source` outcome kind), `composition.ts` (`r/source`, the lock `source` field).
- `cli/src/modules/harness/` — the `BuildSession` binding and the tool contribution.
- The harness change `add-source-build-session` must land with this change, because each side of the interface is useless alone.
