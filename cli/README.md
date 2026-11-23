# Inflexa CLI

The local-first Inflexa TUI/CLI — the user-facing product. It turns a plain-language analysis request into sandboxed, reproducible computation, recorded as a provenance graph in a local SQLite database.

For the product overview, see the [repository README](../README.md). For architecture and conventions, see [`CONTEXT.md`](./CONTEXT.md) and [`CLAUDE.md`](./CLAUDE.md).

## Requirements

- [Bun](https://bun.sh/) — runtime and package manager
- [Docker](https://www.docker.com/), running locally — analyses execute in the sandbox image

## Quick start

```bash
cd cli
bun install

bun run dev setup           # one-time: model connection, local services, sandbox images and packages
bun run dev                 # launch the TUI
bun run dev status          # what `inflexa` resolves to right now (loud context)
```

Build a standalone `inflexa` binary:

```bash
bun run build               # compiles dist/inflexa-<os>-<arch>
bun run dev:install         # put the built binary on PATH as `inflexa`
```

On macOS/Linux `dev:install` symlinks into `dist/`, so every `bun run build` is instantly live; on Windows it copies, so re-run it after each build.

## Scripts

| Script | Does |
|-|-|
| `bun run dev` | Run the CLI from source (launches the TUI) |
| `bun run build` | Compile the standalone binary for this platform |
| `bun run build:all` | Compile for every target platform |
| `bun run dev:install` | Put the built binary on `PATH` as `inflexa` |
| `bun run typecheck` | `inflexa-typecheck` |
| `bun run lint` | oxlint |
| `bun run format` | Prettier over `src/` |
| `bun test` | Run tests |
| `bun run wipe` | Wipe local state (database, config, workspaces) |

## Configuration

Bring-your-own-key for supported LLM providers, plus local models end to end.

`inflexa setup` walks the model connection: either **`cliproxy`** (the default — sign in to a provider through the local CLIProxyAPI container it provisions) or **`direct`** (your own Anthropic or OpenAI-compatible endpoint, with the key read from `INFLEXA_MODEL_API_KEY` in the environment — it is never written to config). It also provisions Postgres, and it starts the two sandbox-image transfers and the package-catalog transfer.

Run `inflexa config` (or `bun run dev config`) to view and edit configuration afterwards. Auth0 settings are read from `.env` — copy `.env.example` to get started.

## Sandbox and packages

Analyses run inside the one runtime image, `sandbox-base`. It carries the language runtimes, the bioconda command-line tools at `/opt/conda`, and the Node packages at `/opt/node` — and NO R or Python package. The analysis packages come from the local **package store**, which a second image, `sandbox-provisioner`, writes. The provisioner is the only container with network access, and it never sees the data of a user.

| Command | Does |
|-|-|
| `inflexa sandbox pull` | Start the two detached image transfers: the runtime image and the provisioner image |
| `inflexa sandbox status` | Show the two images, the live transfer states, and the package-store summary |
| `inflexa sandbox remove` | Remove the two images from the engine; the store and the farms stay |
| `inflexa store download` | Start the detached transfer of the published catalog from GitHub Packages |
| `inflexa store add <pkg>` | Acquire one package into the pool, from PyPI, CRAN, or Bioconductor |
| `inflexa store link <pkgs...>` | Link packages the pool already holds into the farm of one analysis |
| `inflexa store ls` | List the packages, the farms, the live flights, and the disk use |
| `inflexa store reclaim` | Remove store content that no farm references |

`inflexa setup` offers the two image transfers and the catalog transfer as ONE consent, and the three run detached. The published images are multi-arch manifests, thus `docker pull` resolves the host architecture automatically.

- **The store on the host** — the root is `<data dir>/inflexa/package-store`. It holds the content-addressed **pool** (`store/`, one write-once directory per installed distribution), one symlink **farm** per analysis (`farms/<analysis>`, with its own `inflexa.lock`), and the dependency graph (`deps.json`). Each sandbox mounts the store read-only at `/mnt/libs`, with the farm of its analysis nested at `/mnt/libs/farm` and a per-analysis writable cache at `/mnt/libs/cache`.
- **Extend it** — `inflexa store add <pkg> [--version <v>] [--lang python|r] [--analysis <ref>]` resolves the package under the pins the pool already holds, installs it into the pool, and extends the named farm. Without `--lang` the search covers both ecosystems, and a hit in both stops with an ask.
- **Link, do not install** — `inflexa store link` writes symbolic links only, thus it needs no download and no container. A launch links what the plan named, and a run never installs.
- **The agent asks per package** — after the plan, the conversation agent marks each missing package and asks for it through the `run_inflexa` approval flow. A refusal returns as guidance, with an invitation to swap the package.
- **Managed deployments** mount the same store from a shared volume, and the refresher fetches it with this CLI.

## Reference data

The reference store is a folder on the host. Its default path is `~/.local/share/inflexa/refs`. Each sandbox mounts the store read-only at `/mnt/refs` when the folder exists.

To put the store on a different disk, set `refs.dir` in `config.json`, for example `"refs": { "dir": "/Volumes/lab-drive/refs" }`. The value is an absolute path, or a path that starts with `~/`. If the value is a different relative path, the server does not boot.

An agent downloads a missing reference with the `download_ref` tool. The tool writes into the store, and it makes the folder at the first download. A download from a host that is not on the auto-approve list asks the user first. To add hosts to that list, set `refs.autoApproveHosts`, for example `"refs": { "autoApproveHosts": ["data.mylab.org"] }`. An entry also matches each subdomain of the host.

You can put your own reference files in the store. Agents find them with the `list_available_refs` tool.

The `inflexa refs` commands manage the datasets of the reference-data catalog of the CLI. A person or a cloud job runs them. An agent cannot run them, because an agent uses the `download_ref` tool.

| Command | Does |
|-|-|
| `inflexa refs list` | List the catalog datasets with their sources, licenses, and local state |
| `inflexa refs download [ids...]` | Download the selected datasets from their upstream publishers, then make them active |
| `inflexa refs verify [ids...]` | Compare the installed files with the checksums recorded at install |
| `inflexa refs path` | Print the path of the store, and do not make the folder |

Each command uses the store that `refs.dir` sets. If `refs.dir` is a relative path, the command stops with an error.
