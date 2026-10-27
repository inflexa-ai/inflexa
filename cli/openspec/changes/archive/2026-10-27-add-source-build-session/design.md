# Design

## Context

The harness change of the same name defines the `BuildSession` interface and the tool; this change is the binding. The CLI already owns every piece the binding needs: `cli/src/lib/container.ts` resolves and abstracts the container runtime, `provisioner.ts` builds provisioner launches and the load check, `store_flight.ts` runs the two-phase tail, and `composition.ts` composes farms and writes the lock. The conversation composition adds a harness tool when its seam is bound (the `link_packages` pattern), so the CLI binds the interface and passes nothing through `hostTools`. The baseline suites for `src/modules/libs` and the provisioner images are green.

## Goals / Non-Goals

**Goals:**

- One session module that realizes `start`/`exec`/`commit`/`stop` over the container runtime, with the wall installed at container start and restarts on approval.
- The clean run reuses the existing flight tail with no fork of the commit logic.
- The egress wall of a session is approved host by host, and the pristine snapshot never absorbs session state.

**Non-Goals:**

- A durable session, a session resume, or a Kubernetes realization.
- Any change to the pending-set batching of `store add` — a source build is not a `store add` and never enqueues.
- A credential UI for private repositories.

## Decisions

### D1 — One module beside `provisioner.ts`, not inside it

The session logic (held container, wall install, exec, snapshot, egress assembly, restart) lives in a new `cli/src/modules/libs/build-session.ts` with its own tests, importing the runtime helpers from `lib/container.ts` and the image resolution from `provisioner.ts`. `provisioner.ts` keeps its one-shot shape and gains only the `acquire-source` launch args and the session egress constant.

### D2 — The held container overrides the entrypoint and installs the wall at start

The session container runs `sh -c '. /usr/local/bin/egress-allowlist.sh; apply_egress_allowlist; exec sleep infinity'` with the session's `INFLEXA_EGRESS_ALLOW` in its environment — the same function the provisioner entrypoint sources, so one mechanism serves both shapes. The exploration start holds the git host alone (a folder source holds no host); the plan approval and any amended plan restart the container under the new list over the same scratch volume. Each `exec` call runs the runtime's exec with its own timeout, in a fresh shell, as the non-root user by default; an exec the tool marks as root runs as root and its ask says so.

### D3 — Two trees: the pristine snapshot and the working copy

The host clones at the resolved commit — or copies the folder — into a pristine snapshot under the scratch volume, hashes a folder source over that copy with the provisioner's `tree_hash` (run in a short container over the volume, so the CLI never reimplements the hash), and gives the session a working copy of the same tree. The clean run mounts the pristine snapshot alone. `GITHUB_PAT` reaches the clone command's environment alone: the realization builds the clone exec env per command, and no later exec env, tool result, or record holds the token.

### D4 — The clean run is a flight, not a new surface

The tool's `commit` call starts a flight-shaped flow: the source flight row is created here, keyed by the qualified pin; one `acquire-source` provisioner run (same runner, same lock discipline, its own report file under `.inflexa-download`, the session egress class, and both image digests in its environment); then `runLoadCheck`, then `commitStagedNodes`, then `extendFarm` for the subscribed analysis. The acquire-report schema gains the `source` outcome kind; a refusal settles as a `failed` row through the existing vocabulary, and the retry action of the surfaces refuses a source row — a source build restarts through the tool. A farm-extension failure logs and does not fail the flight, exactly as an index acquisition.

### D5 — The lock `source` field and the `r/source` subtree are read at composition time

`lockPackageEntry` in `composition.ts` reads `.inflexa-build.json` when the pin marker holds a qualifier, copies its source block into the entry, and the link plan sends a source-built R package to the `source` subtree (the template's subtree map answers `source` for a qualified pin, where it answers `cran` by default today). The record is the one provenance surface: the provisioner writes it, the lock copies it, and no second writer exists.

### D6 — Two refusals guard one name

The Python link pass already refuses two store directories of one distribution through `isVersionCollision`; the R link pass must gain the same refusal, because today it skips an occupied link in silence and the lock would then name two packages under one link. `pickVersion` must also refuse when two directories of one identity answer the same version, on the store-link path and the farm-extension seam alike, naming both directories — a silent head pick would serve the fork to a caller that named neither build.

## Risks / Trade-offs

- [`docker exec` has no submit/poll, so a long command blocks the chat turn] → Each exec carries its own timeout, the ask flow bounds what runs, and the tool result keeps the whole log for later reads.
- [A session container can leak if the host dies] → The session registers cleanup on process exit; a leaked container is inert (no store mount, walled egress) and removable as debris.
- [The tree hash of a folder must match the build record] → Both hashes come from the same provisioner function over the same pristine copy; the CLI never recomputes the hash.
- [The qualified pin widens the flight key] → The key format `<track>::<spelling>::<specifier>` holds the qualifier inside the specifier field, so the ledger needs no new column.
- [A root exec can flush the nft rules] → Accepted by the issue's trust position: the user approves each command, and the wall is a guardrail, not a boundary against approved code.

## Migration Plan

None. The store, the ledger, and the lock schema stay as they are; `source` is additive. Rollback is a revert.
