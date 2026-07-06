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

bun run dev                 # launch the TUI
bun run dev doctor          # check Docker, architecture, disk, runtime
```

Build a standalone `inflexa` binary:

```bash
bun run build               # compiles dist/inflexa-<os>-<arch>
```

## Scripts

| Script | Does |
|-|-|
| `bun run dev` | Run the CLI from source (launches the TUI) |
| `bun run build` | Compile the standalone binary |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | ESLint |
| `bun run format` | Prettier over `src/` |
| `bun test` | Run tests |

## Configuration

Bring-your-own-key for supported LLM providers, plus local models end to end. Run `inflexa config` (or `bun run dev config`) to view and edit configuration. Auth0 settings are read from `.env` — copy `.env.example` to get started.

## Sandbox image

Analyses run inside a **sandbox image** that bakes the R / Python / conda / Node packages at `/mnt/libs/current`. You choose a variant and pull it from GitHub Packages:

| Command | Does |
|-|-|
| `inflexa sandbox pull [variant]` | Pull a sandbox image (`python` = Python + bioconda CLI tools + Node; `python-r` = that plus R) from `ghcr.io/inflexa-ai/inf-cli/sandbox-<variant>` and configure sandboxes to use it |
| `inflexa sandbox status` | Show the configured variant, its GHCR reference, whether the image is present locally, and its digest |

`inflexa sandbox pull` also runs during `inflexa setup`. Before a sandbox launches, a missing image is offered and pulled (`inflexa profile` needs it). The published images are multi-arch manifests, so `docker pull` resolves the host architecture automatically — you pick only the variant, never the architecture. Flags: `--yes` skips the download confirmation.

- **No local store** — the packages ship inside the pulled image, so there is no `~/.local/share/inflexa/libs` tree, no `/mnt/libs` bind mount, and no architecture-forcing. `harness.sandboxImage` (in `config.json`) records the pulled image tag; set it to a custom `FROM`-extended image to run your own.
- **Extend it** — `FROM ghcr.io/inflexa-ai/inf-cli/sandbox-python-r` then `RUN pip install …` / `install.packages(…)` lands in the store automatically (the image exports `PIP_TARGET`/`R_LIBS_USER`/`INFLEXA_LIB_ROOT`); run `inflexa-libs-refresh` afterward so the additions show up in `list_available_packages`. See `images/sandbox-python*/README.md`.
- **Managed deployments** still mount per-track tarballs read-only (cold-start friendly); those tarballs are extracted from these same images by the build pipeline and are infra-managed, not a CLI concern.
