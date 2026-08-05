# The host package store

Analyses run in a sandbox image. The image bakes the R, Python, conda, and Node
packages at `/mnt/libs/current`. `inflexa sandbox pull` gets this image, and it is
the default path. This document describes an opt-in alternative: a host package
store that a sandbox mounts read-only.

Use the store when you must add a package that the image does not bake. The store
lets you provision the package on the host. A later sandbox mounts the store. The
sandbox then imports the package.

Caution: the store is off by default. If you set no store, the behavior does not
change. The sandbox reads the store that the image bakes, and no `/mnt/libs` bind
mount exists.

## The default path

`inflexa sandbox pull` stays the default path. The packages ship inside the pulled
image. There is no host store, no `/mnt/libs` bind mount, and no store command is
necessary. Refer to the "Sandbox image" section of the README.

## Opt in

To opt in, set two keys in the `harness` block of `config.json`:

- `libStorePath` — the host directory of the package store. The harness mounts this
  directory read-only at `/mnt/libs` in each sandbox. Unset, no store is passed and
  no bind mount exists.
- `provisionerImage` — the provisioner image reference that the store commands run.
  This key has no default. The source of the provisioner image for a user machine
  is an open decision. Thus a store command that provisions or removes content
  stops with guidance when this key is unset.

Example:

```json
{
  "harness": {
    "libStorePath": "/Users/you/.local/share/inflexa/store",
    "provisionerImage": "inflexa-provisioner:local"
  }
}
```

To roll back, clear the `libStorePath` key. The image is unchanged, and it is the
working fallback.

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

`list_available_packages` reads its inventory from a host path. With a store
configured and usable, the inventory is the store's active farm. With no store, or
with a store that the harness refuses, the inventory is the image label cache. The
rule is that the inventory always describes what the sandbox mounts.

## The macOS performance cost

Caution: the store is slower than the image on macOS. An import through the
bind-mounted store measured 2.73 s. The same farm on the container filesystem
measured 1.18 s. The cause is virtiofs on the bind mount, not the design.

macOS is the primary local development platform, thus a developer meets this cost
exactly where the store is opt-in. As a result, the image path stays the default.
Before you recommend the store as the default, re-measure the number on Linux.
