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

bun run dev setup           # one-time: model connection, sandbox image, local services
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
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | ESLint |
| `bun run format` | Prettier over `src/` |
| `bun test` | Run tests |
| `bun run wipe` | Wipe local state (database, config, workspaces) |

## Configuration

Bring-your-own-key for supported LLM providers, plus local models end to end.

`inflexa setup` walks the model connection: either **`cliproxy`** (the default — sign in to a provider through the local CLIProxyAPI container it provisions) or **`direct`** (your own Anthropic or OpenAI-compatible endpoint, with the key read from `INFLEXA_MODEL_API_KEY` in the environment — it is never written to config). It also provisions Postgres and pulls the sandbox image.

Run `inflexa config` (or `bun run dev config`) to view and edit configuration afterwards. Auth0 settings are read from `.env` — copy `.env.example` to get started.

## Sandbox image

Analyses run inside the one **sandbox image**, `sandbox-base`. It carries the language runtimes, the bioconda command-line tools, and the Node packages — and NO R or Python package. The packages come from the local **package store**:

| Command | Does |
|-|-|
| `inflexa sandbox pull` | Pull `ghcr.io/inflexa-ai/sandbox-base` and configure sandboxes to use it |
| `inflexa sandbox status` | Show the images, the live transfers, and the store state |
| `inflexa store download` | Install the published package store (the catalog) |
| `inflexa store add <pkg>` | Acquire one more package into the store pool |

`inflexa setup` offers the image pulls and the catalog download as one consent, and they run detached. The published image is a multi-arch manifest, thus `docker pull` resolves the host architecture automatically.

- **The local store** — the packages live under `$XDG_DATA_HOME/inflexa/package-store`. Each sandbox mounts them read-only at `/mnt/libs`, beside the farm of its analysis.
- **Extend it** — `inflexa store add <pkg>` acquires from PyPI, CRAN, or Bioconductor, and `inflexa store link` connects a pool package into the farm of an analysis.
- **Managed deployments** mount the same store from a shared volume, and the refresher fetches it with this CLI.

## Reference data

`inflexa refs path` prints the public reference store (normally `~/.local/share/inflexa/refs`). When that directory exists, it is mounted read-only in sandboxes at `/mnt/refs`; sandboxed analyses remain offline and cannot download into it themselves.

| Command | Does |
|-|-|
| `inflexa refs list` | List the harness catalog with versions, sizes, integrity class, source/license links, and local state |
| `inflexa refs download [ids...]` | Download from the upstream publishers, verify, and atomically activate selected datasets |
| `inflexa refs verify [ids...]` | Hash active managed files and report missing or modified content |
| `inflexa refs path` | Print the host path without creating it |

**Every dataset is fetched straight from the third party that publishes it — NCBI, Reactome, WikiPathways, Zenodo, GTEx, CellTypist. This project mirrors, re-hosts, and redistributes nothing**, so there is no endpoint to configure and the licence you accept is the upstream's.

That upstream decides what integrity we can honestly promise, and `refs list` tells you which you get:

- **pinned** — the upstream publishes immutable, versioned bytes, so the catalog carries their size and SHA-256. A download is verified against the catalog *before* it is activated; a mismatch fails the install and changes nothing on disk.
- **unpinned** — the upstream rebuilds the same URL in place (NCBI regenerates `gene_info` daily; Reactome overwrites `current` and deletes the prior release), so no checked-in digest could survive. Integrity is trust-on-first-use: the installer records the bytes it actually received, and `refs verify` proves they have not changed *since you installed them*. This is a weaker guarantee, and it is labelled as one.

`refs download --force` re-fetches even when a dataset is already installed: it repairs a damaged install and is how you refresh an `unpinned` dataset once its upstream has moved on.

The CLI owns `managed/` and `.inflexa/` below the store. Put arbitrary reference files under `user/`; the installer never adopts, verifies, overwrites, or deletes that content, and sandbox discovery sees it dynamically. Nothing in the sandbox image points a library at the store — agents call `list-available-refs` and pass the returned absolute paths explicitly. If a useful dataset is missing, custom files work immediately, and a PR adding its upstream URL, provenance, and licensing to the harness catalog makes it an opt-in setup choice for everyone.
