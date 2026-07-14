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

Analyses run inside a **sandbox image** that bakes the R / Python / conda / Node packages at `/mnt/libs/current`. You choose a variant and pull it from GitHub Packages:

| Command | Does |
|-|-|
| `inflexa sandbox pull [variant]` | Pull a sandbox image (`python` = Python + bioconda CLI tools + Node; `python-r` = that plus R) from `ghcr.io/inflexa-ai/sandbox-<variant>` and configure sandboxes to use it |
| `inflexa sandbox status` | Show the configured variant, its GHCR reference, whether the image is present locally, and its digest |

`inflexa sandbox pull` also runs during `inflexa setup`. Before a sandbox launches, a missing image is offered and pulled (`inflexa profile` needs it). The published images are multi-arch manifests, so `docker pull` resolves the host architecture automatically — you pick only the variant, never the architecture. Flags: `--yes` skips the download confirmation.

- **No local store** — the packages ship inside the pulled image, so there is no `~/.local/share/inflexa/libs` tree, no `/mnt/libs` bind mount, and no architecture-forcing. `harness.sandboxImage` (in `config.json`) records the pulled image tag; set it to a custom `FROM`-extended image to run your own.
- **Extend it** — `FROM ghcr.io/inflexa-ai/sandbox-python-r` then `RUN pip install …` / `install.packages(…)` lands in the store automatically (the image exports `PIP_TARGET`/`R_LIBS_USER`/`INFLEXA_LIB_ROOT`); run `inflexa-libs-refresh` afterward so the additions show up in `list_available_packages`. See [`images/README.md`](../images/README.md).
- **Managed deployments** still mount per-track tarballs read-only (cold-start friendly); those tarballs are extracted from these same images by the build pipeline and are infra-managed, not a CLI concern.

## Reference data

`inflexa refs path` prints the public reference store (normally `~/.local/share/inflexa/refs`). When that directory exists, it is mounted read-only in sandboxes at `/mnt/refs`; sandboxed analyses remain offline and cannot download into it themselves.

| Command | Does |
|-|-|
| `inflexa refs list` | List the harness catalog with versions, sizes, source/license links, and local state |
| `inflexa refs download [ids...]` | Download, checksum, and atomically activate selected catalog datasets |
| `inflexa refs verify [ids...]` | Hash active managed files and report missing or modified content |
| `inflexa refs path` | Print the host path without creating it |

The CLI owns `managed/` and `.inflexa/` below the store. Put arbitrary reference files under `user/`; the installer never adopts, verifies, overwrites, or deletes that content, and sandbox discovery sees it dynamically. Catalog artifacts resolve through the configured `INFLEXA_REFERENCE_DATA_BASE_URL`; source and license links stay in the harness-owned catalog. If a useful dataset is missing, custom files work immediately, and a PR adding immutable file sizes/checksums and provenance to the harness catalog makes it an opt-in setup choice for everyone.
