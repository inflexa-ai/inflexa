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

## Library store

Analyses run against a shared, read-only **library store** (R / Python / conda / Node packages) mounted into each sandbox at `/mnt/libs`. Obtain it with:

| Command | Does |
|-|-|
| `inflexa libs pull` | Download and atomically activate the store for this machine's architecture (the full R stack on amd64; Python + conda on arm64, where R is not yet built) |
| `inflexa libs status` | Show the active version, architecture, present tracks, and whether an update is available |

`inflexa libs pull` also runs during `inflexa setup`, and a missing store is offered — never required — before a sandbox launch (the harness degrades to "packages not available"). Flags: `--pin <V>` targets a specific published version instead of `latest`, `--yes` skips the size confirmation.

- **Store location** — `<data dir>/inflexa/libs/` (e.g. `~/.local/share/inflexa/libs/`), a versioned tree with a `current` symlink; see the Paths table in `inflexa --help`. The harness bind-mounts it read-only only once `current` exists, and forces sandbox containers onto the store's recorded architecture.
- **`INFLEXA_LIB_STORE_URL`** — overrides the published-store base URL (default: the public bucket; anonymous GET, no credentials).
- The pull is content-addressed and dedup-aware: unchanged tracks transfer zero bytes. The build pipeline's release validation ("Gate 2") pulls a candidate version through this same handler via `--pin` before promoting `latest`.
