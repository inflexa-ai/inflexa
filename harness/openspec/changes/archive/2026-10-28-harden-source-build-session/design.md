# Design

## Context

The archived change `2026-10-27-add-source-build-session` added the `BuildSession` interface, the `install_from_source` tool, and `acquire-source`. Its design D2 accepted that a root exec can delete the wall. The review of pull request #753 rejects that position, and this change makes the wall and the store hold against the code of the session. The sibling CLI change of the same name holds the realization decisions. See proposal.md for the list of findings.

## Goals / Non-Goals

**Goals:**

- No host file reaches the model context without an ask.
- The approved script never runs with a capability, and it never writes the store.
- A canceled turn ends each long session operation.
- The tool text states each fact that the agent depends on.

**Non-Goals:**

- A new home for the tool. Decision H1 keeps it in the harness.
- A durable session.
- A change to the acquisition egress classes or to `store add`.

## Decisions

### H1 — The tool stays in the harness

The tool holds the approval policy: the exploration phase, the plan ask, the per-command ask with a session grant, and the commit ask. The root `CLAUDE.md` rule says that a capability goes into the harness and the embedder supplies the realization. `link_packages` over `ExtendAnalysisFarm` has the same shape.

A host tool through `hostTools` is for a concept that the harness does not have. `list_launch_dir` is the example, because the harness has no launch directory. The harness owns the package store and the farm, thus a build into the store is a harness concept. A second embedder then gets the same asks with no copy of the policy.

Alternative: move the tool to the CLI as a host tool. Rejected. The CLI would own the approval policy, and a different embedder would write its own policy.

### H2 — Each start asks with its source

A folder start reads a host directory outside the analysis tree into the session, and an exploration exec can print it. A git start with the token can clone a private repository of the user, and an exploration exec can print it too. Thus each start asks first, and the ask shows the source. The review proposed this fix. The exploration execs then need no ask, because the user approved the source.

Alternative: confine the folder to the launch folder. Rejected, because the launch folder is a concept of the CLI, and the harness cannot name it.

Alternative: ask only for a folder start. Rejected, because a git start with the token also exposes data of the user.

### H3 — The schema accepts a host name only

The wall puts each host into one dnsmasq `--nftset` argument, and a listed domain covers its subdomains. Thus `com` opens a whole top-level domain, and a `/` adds a domain that the ask does not show. The schema accepts a name of two or more DNS labels, whose last label holds letters alone. The host of a git URL obeys the same rule, and the URL scheme must be `https` or `http`. An IP literal fails the rule, because the wall resolves names. The check ignores case, and the schema gives the host in lower case, so the ask and the wall show one spelling.

### H4 — The tool holds a lock for each session

The loop runs the `step` calls of one round in parallel. The CLI also runs two turns at the same time, and one tool instance serves each thread. Thus the tool keeps a promise chain for each session id. Each `exec`, `commit`, and `stop` runs its whole body, the asks included, inside the chain of its session. The chain entry goes away when the session ends.

Alternative: `executionMode: "inline"`. Rejected, because it orders the calls of one round only, and two turns still overlap.

### H5 — The interface carries the signal of the turn

`start`, `exec`, and `commit` take the `AbortSignal` of the tool context as their last parameter. `commit` takes a request object `{ script, packageDir? }`. An aborted call rejects, and the tool returns `failed` with the reason. The session stays open after an aborted `exec` or `commit`. `stop` takes no signal, because it is short and it must finish.

### H6 — The commit names the R package directory

pak resolves the dependencies from a directory that holds a `DESCRIPTION`. A monorepo package has its `DESCRIPTION` in a subdirectory. The commit field `packageDir` names that directory. The schema refuses an absolute path and a `..` segment. `acquire-source` also resolves the real path and refuses a path outside the snapshot. The commit ask and the build record show the value.

Alternative: state the limit in the tool text. Rejected, because the source of a forked monorepo package then cannot build unless the pool holds each dependency.

Alternative: find the `DESCRIPTION` by a search of the tree. Rejected, because a tree can hold more than one package.

### H7 — The clean run drops to uid 1000 and cannot reach the read-write store

The run installs the apt packages of the plan as root, after the apt pin. The names must match the Debian package-name rule, so a value that starts with `-` cannot become an option. Then the run executes the script through `setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs`. This is the pattern of `images/sandbox-base/sandbox-entrypoint.sh`.

uid 1000 alone does not protect the store. Take a rootful Linux engine whose host user has uid 1000. The host user owns the farms and the catalog directories, thus container uid 1000 can write them. Thus the run also makes the parent of the store mount (`/mnt`) mode 0700 before the drop. The container kernel enforces that mode, for each engine and each host. The R dependency library of the script uses relative links. The script reads it through a read-only view of the store that the host mounts at a second path, given by `--lib-view`.

The run copies the approved script into a root-owned file of mode 0755 and runs the copy. The output directory belongs to uid 1000. `HOME` names the home of the `inflexa-build` user.

Alternative: run the script in a third container with the store read-only. Rejected, because it splits one run into three and carries the cleanup list across them, for the same isolation.

Alternative: run the script as a uid that no host user has. Rejected, because the session proves the script as uid 1000, and the ownership emulation of an engine can still grant the write.

### H8 — A failed dependency install refuses

`source_python_dependencies` appends each installed directory to the list of the caller as it goes. A `ResolveError` or a `SystemExit` from `ensure_stored` becomes a `SourceBuildError`. The refusal path then removes each new directory, and the run writes its report.

### H9 — The debris pass removes the source reports

`reclaim --debris` globs `source-*.json` beside `acquire-*.json`. The flight removes its report on each path, and the glob removes the report of a host process that stopped.

### H10 — The tool text states the restart and the clean run

The description adds three facts. A plan restart keeps `/work` alone, thus the agent installs the apt packages and the libraries again. The clean run installs the apt packages of the plan and runs the script as the non-root user. Thus the script holds no `apt-get` and no root step. An R package in a subdirectory names its directory in `packageDir`.

## Risks / Trade-offs

- [A build that needs root in the clean run fails] → The session proves the script as the non-root user. The plan names the apt packages of the run.
- [The session and the clean run install apt packages in different ways] → Both use the same dated snapshot and the same names from the plan.
- [A folder ask adds one approval] → It occurs once for each folder session, and it protects host files.
- [A call waits on a long ask of its session] → Only calls on the same session wait. The earlier call ends at its ask answer or at the abort.

## Migration Plan

No data migration. The interface change breaks an embedder, and the CLI is the only embedder. The sibling CLI change must land with this change. Rollback is a revert of both changes.
