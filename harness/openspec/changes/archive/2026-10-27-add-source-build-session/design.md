# Design

## Context

The provisioner today is a one-shot `docker run --rm` (`cli/src/modules/libs/provisioner.ts`): the CLI streams one subcommand and the container dies. The spec permits five subcommands and `acquire` refuses a git or location spec by grammar (`provision.py` `refusal_reason`). The conversation tool surface already has the two precedents this change copies: an embedder-bound interface (`ExtendAnalysisFarm`, `harness/src/sandbox/types.ts`) and a tool gated on it (`link_packages`, added by the agent composition when the seam is bound — not through `hostTools`). `ctx.ask` exists on the chat path and the tool-approval spec forbids a blocking ask inside a DBOS step, which the chat path satisfies. The tool-result cap and `read_tool_output` already bound long outputs. The provisioner image and sandbox-base share one base-image digest, which the link rule leans on. The issue's own flow (read repository → plan → approve → build) forces an exploration phase before the plan ask, which shapes the tool.

## Goals / Non-Goals

**Goals:**

- One harness interface and one conversation tool that any embedder can bind.
- A session that is powerful enough to build arbitrary R and Python sources, and constrained enough to approve: no store mount, egress from the approved plan, one ask per command.
- The stored artifact always comes from one clean run of one script over a pristine snapshot, through the existing load check, commit, and farm extension.

**Non-Goals:**

- C and C++ command-line tools (#747) — they reuse the session later.
- The AnnotationHub reference data of SeedMatchR (#698).
- Any change to `store add`, its grammar, or the sandbox-agent prompts.
- A durable session across host restarts.

## Decisions

### D1 — The tool is one call per operation, and the session explores before the plan

The tool input is a discriminated union: `start(source)`, `exec(sessionId, command)`, `commit(sessionId, script)`, `stop(sessionId)`. Each call returns, the agent reads the result, and the next call chooses the next step — the only shape in which a per-command ask works, because `ctx.ask` pauses the tool call it runs in. `start` begins an exploration phase: the container's egress holds the git host alone (a folder source needs no host), the pristine snapshot lands, and the agent reads the tree through exec calls. After the exploration the plan ask names the source, the commit, the host list, the apt packages, and the strategy; the approval restarts the container under the approved egress with the same scratch tree. A wall failure mid-session can raise one amended plan ask, which restarts the session again under the wider list.

### D2 — The session container is held with the wall installed at start

The CLI starts the provisioner image detached with an entrypoint override: source `egress-allowlist.sh`, apply the allowlist, then hold (`sleep infinity`). The same function the entrypoint uses installs the wall, so a session container and a provisioner run share one mechanism. A restart under a wider or narrower list is a new container over the same scratch volume. Each command arrives through the runtime's exec channel (`cli/src/lib/container.ts` abstracts docker and podman) with its own timeout. A root exec can flush the nft rules — the issue's trust position accepts root build scripts behind per-command approval, and the wall is a guardrail, not a boundary against the code the user approved command by command.

Alternative: the Go `sandbox-server` baked into sandbox-base gives submit/poll and is closer to a Kubernetes realization. Rejected for now: it is not in the provisioner image, its provenance and capture layers serve sandbox steps rather than builds, and the chat path is not durable, so submit/poll buys no replay. The `BuildSession` interface hides the channel, so a later realization can swap it without a harness change.

### D3 — The pin qualifier rides the marker; the directory name keeps the bare version

The pin of a source build reads `name==version@git:<full-sha>` or `name==version@tree:<sha16>`. The store directory name keeps the bare metadata version, because the graph node version comes from the metadata and the directory name (`emit_deps` parses it). `find_stored` strips the qualifier for the directory glob and requires the full marker text, so the two builds of one name and version stay apart and a repeat build of the same qualified pin reuses its directory.

### D4 — A private repository authenticates with the token of the clone alone

When the host environment holds `GITHUB_PAT`, the CLI passes it into the environment of the clone command and of no other exec — a container-wide variable would reach every later command, including one a README steered. The plan, the tool results, and the build record never hold it. This reuses the one convention the codebase already has (`provision.py` `cmd_build` refuses a github manifest entry without `GITHUB_PAT`).

Alternative: a credential prompt or a credential store. Rejected for this change: no credential UI exists in the CLI today, and the acceptance cases are public sources.

### D5 — The clean run is one `acquire-source` flight with a fixed script contract

The script builds exactly one root artifact into a named output directory (`/work/out`): one installed R package directory, or one built wheel. The script never installs dependencies — `acquire-source` does that itself, the R root through a pak lockfile resolve of the snapshot tree and the Python root through a hash-pinned resolve of the wheel requirements, both through the current pool paths. The report rides the acquire-report shape with an added `source` outcome kind. The host then runs the unchanged tail: the load check in the sandbox image (with the `ldd`/`R CMD ldd` link rule), `commitStagedNodes`, `extendFarm`. A farm-extension failure does not fail the flight — the packages are in the pool and the graph, exactly as an index acquisition, and a later link extends the farm.

### D6 — The pristine snapshot and the working copy are two trees

The host clones (or copies) once into a pristine snapshot under the scratch volume, takes the folder tree hash over that copy before any command, and gives the session a working copy. The clean run mounts the pristine snapshot alone. This is what makes "the session used a state the script does not make" detectable: a dirty working copy cannot leak into the stored artifact.

### D7 — apt in the session uses the Ubuntu snapshot of the base-image build date

The image keeps no apt lists. The session's first apt step runs `apt-get update` against `snapshot.ubuntu.com` at the plan's date, the build record holds the snapshot date and the resolved package versions, and the plan names the snapshot host in the egress list. The date comes from the build date of the shared base image, which the host reads from the image metadata — a snapshot of that era installs libraries that match the image the link rule checks against, and the LLM never picks the date. The provisioner image gains `autoconf`, `automake`, `libtool`, `meson`, `ninja-build`, and `patchelf` on its own Dockerfile line rather than in `install-build-toolchain.sh`, keeping the shared script's package set unchanged for every future consumer.

### D8 — The ask flow composes exactly as `run_inflexa` does

The plan ask, the amended plan ask, the per-command ask with a session-scoped `grantKey`, and the commit ask all use `AskRequest`/`ctx.ask`. An `exec` that runs as root says so in its ask. A rejection throws `AskRejectedError` and is deliberately not caught, matching `inflexa_tool.ts`: the loop maps the throw to an execution-denied result and ends the turn, and the session stops.

## Risks / Trade-offs

- [A build script runs arbitrary code as root in the session] → The session has no store mount, the egress wall bounds the network to the approved hosts, the user approves the plan and each command, and only the clean run writes the pool. The risk class equals a source build that pak or uv already runs today behind one approval. A root exec can tear the wall down; the issue's trust position accepts this class behind per-command approval.
- [The LLM writes a script that only works in the used session state] → The clean run reads the pristine snapshot, never the working copy; on failure the session stays open and the agent corrects the script there. The clean run is the only writer, so a wrong script costs no store state.
- [`docker exec` couples the realization to the Docker/Podman API] → `container.ts` already hides the runtime choice; the harness interface hides the channel.
- [A held container can outlive a crashed host process] → The session registers its container for removal on process exit (best effort), and a leaked container holds no store mount and walled egress, removable as debris.
- [Two source builds of one name and version] → The qualified pin keeps the pool directories apart; the farm link refuses the second one in one farm, and the remedy names both directories.

## Migration Plan

No migration: the store layout, `deps.json` version, and farm-lock schema number stay as they are. The `source` field and the `r/source` subtree are additive; an older host ignores both. Rollback is a revert — no written state needs repair.
