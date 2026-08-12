# The host package store

Analyses run in a sandbox image. The image bakes the R, Python, conda, and Node
packages at `/mnt/libs/current`. `inflexa sandbox pull` gets this image, and it is
the default path. This document describes an opt-in alternative: a host package
store that a sandbox mounts read-only.

Use the store when you must add a package that the image does not bake. The store
lets you provision the package on the host. A later sandbox mounts the store. The
sandbox then imports the package.

Caution: the store is off by default. If you do not turn the store on, the behavior
does not change. The sandbox reads the store that the image bakes, and no
`/mnt/libs` bind mount exists.

## The default path

`inflexa sandbox pull` stays the default path. The packages ship inside the pulled
image. There is no host store, no `/mnt/libs` bind mount, and no store command is
necessary. Refer to the "Sandbox image" section of the README.

## The location of the store

The store root is a fixed path that the CLI owns:
`<data directory>/inflexa/lib-store`. It is the peer of the reference store. There
is no configuration key for it, and thus no user override. Run `inflexa env` to see
the resolved path on your machine.

One location keeps the writers and the reader in agreement. The store commands and
the store download write there. Boot reads there. As a result, a store that you
populate is the store that a sandbox mounts.

## No configuration key

The store is mandatory, and no key turns it on or off. The runtime image bakes no R
library and no Python library, thus a sandbox with no store could import nothing.
The CLI passes the store root to the harness for every sandbox.

The provisioner image reference is a constant of the CLI, and no key moves it.

Two keys governed this before, and both are dead: `libStore` and
`provisionerImage`. A configuration file can still carry one, because the schema is
not strict and an unknown key is inert. The CLI names a dead key one time at boot
and says why it governs nothing — refer to `REMOVED_HARNESS_KEYS` in
`src/modules/harness/config.ts`.

There is no roll back to a sandbox with no store. To recover the disk space, remove
the store root.

## The store commands

The `store` noun manages the host store. The provisioner container does each write.
It is the one container with network access and a compiler.

| Command | Does |
|-|-|
| `inflexa store add <packages...>` | Acquire Python packages into the pool. It does no farm work, and it takes no farm name. |
| `inflexa store ls` | List the store's packages, farms, and disk use. This command only reads the host store. |
| `inflexa store remove-farm <farm>` | Remove a farm's symlinks. The packages stay until reclaim runs. |
| `inflexa store reclaim` | Remove the farms whose analysis is gone, then remove store packages that no farm references. The command reports them before it removes them. |

`add`, `remove-farm`, and `reclaim` each start the provisioner container, and each
is approval-gated, the same as `inflexa sandbox pull`. `ls` only reads the host
filesystem, thus it stays prompt-free.

## One farm for each analysis

There is no active farm at the store level, and no command switches one. The store
holds one content-addressed pool (`store/`), the resolved dependency graph
(`deps.json`), and one farm for each analysis at `farms/<analysisId>`. A farm is a
tree of symbolic links into the pool.

The CLI composes a farm on the host, with no container. The first sandbox action of
an analysis makes its farm, thus an analysis in which the user only chats makes
none. The default closure is the requested set of the catalog farm, which the
download brings as the TEMPLATE and never as an environment.

`inflexa store add` acquires into the pool alone. The farm of an analysis changes
only through composition: the flight extends the farm of each analysis that
subscribed to it, and an import failure extends a farm on demand. `analysis delete`
removes the farm, and a removal refuses while a lease records a live sandbox of it.

## The inventory reads the pool

`list_available_packages` reads its inventory from a host path. The CLI supplies
the POOL inventory of the store, derived from `deps.json` and cached at
`<store root>/packages.txt`. The pool is the honest answer for planning, because
composition can link any pool package into a farm on demand. Inside a sandbox the
truth stays the farm that the sandbox mounts, which is what composition made for
that analysis.

The CLI reports no inventory from a second source. The runtime image bakes no
library, thus the per-image label cache describes an empty set.

A store with no dependency graph, or a graph that names no package, is unusable: a
sandbox of it could import nothing. The boot does not fail on it, because chat, the
workspace read surface, and the planner use no package. The sandbox gate holds each
action that would make a sandbox, and it names the remedy.

A farm that cannot be composed is a second such state. The provider records the
reason, and the gate names it at the next sandbox action.

## The macOS performance cost

Caution: the store is slower than the image on macOS. An import through the
bind-mounted store measured 2.73 s. The same farm on the container filesystem
measured 1.18 s. The cause is virtiofs on the bind mount, not the design.

macOS is the primary local development platform, thus a developer meets this cost
exactly where the store is opt-in. As a result, the image path stays the default.
Before you recommend the store as the default, re-measure the number on Linux.

## The store download and the sandbox gate

The CI-built store arrives from GHCR as an OCI artifact, one for each
architecture. The CLI pulls it anonymously, over https, with each layer checked
against its digest. The receipt on disk records the manifest digest.

The first download asks one time, inside the TUI, with the size. An update never
downloads silently. The receipt reports `update_available`, and the CLI asks.

The app never waits for the store or for the image. Each action that makes a
sandbox holds at the gate until the receipt reports a complete store. The gate
reports its state through the notice toast, and a failed download offers a
retry. With the store off, only the image half of the gate applies.
