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

## Opt in

To opt in, set two keys in the `harness` block of `config.json`:

- `libStore` — the switch for the package store. It is a boolean, and it is `false`
  by default. Set it to `true`, and the harness mounts the store root read-only at
  `/mnt/libs` in each sandbox. It also lets the CLI download the store. `false`, or
  absent, passes no store to the harness and makes no bind mount. The key controls
  the mount only, not the location.
- `provisionerImage` — the provisioner image reference that the store commands run.
  This key has no default. The source of the provisioner image for a user machine
  is an open decision. Thus a store command that provisions or removes content
  stops with guidance when this key is unset.

Example:

```json
{
  "harness": {
    "libStore": true,
    "provisionerImage": "inflexa-provisioner:local"
  }
}
```

To roll back, set `libStore` to `false`, or remove the key. Boot then passes no
store root, and no sandbox mounts the store. The image is unchanged, and it is the
working fallback. The store content stays on disk, thus a later opt-in needs no
second download. To recover the disk space, remove the store root.

## The store commands

The `store` noun manages the host store. The provisioner container does each write.
It is the one container with network access and a compiler.

| Command | Does |
|-|-|
| `inflexa store add <packages...>` | Provision Python packages into the active farm. `--farm <name>` selects a named farm. |
| `inflexa store ls` | List the store's packages, farms, and disk use. This command only reads the host store. |
| `inflexa store remove-farm <farm>` | Remove a farm's symlinks. The packages stay until reclaim runs. |
| `inflexa store reclaim` | Remove store packages that no farm references. The command reports them before it removes them. |

`add`, `remove-farm`, and `reclaim` each start the provisioner container, and each
is approval-gated, the same as `inflexa sandbox pull`. `ls` only reads the host
filesystem, thus it stays prompt-free.

## The inventory follows the mount

`list_available_packages` reads its inventory from a host path. With the store on
and usable, the inventory is the store's active farm. With the store off, or with a
store that the harness refuses, the inventory is the image label cache. The rule is
that the inventory always describes what the sandbox mounts.

Boot records one store condition only: a store root that exists and yet carries no
readable active-farm inventory. That is a broken or a partial store. A store root
that is not there is the normal state before the first download, thus boot says
nothing about it.

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
